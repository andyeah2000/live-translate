import Foundation

@MainActor
public protocol LiveTransport: AnyObject {
    var statusCode: Int? { get }
    func resume()
    func receive() async throws -> Data
    func send(_ data: Data) async throws
    func ping() async throws
    func close()
}

@MainActor
public final class URLSessionLiveTransport: LiveTransport {
    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    public var statusCode: Int? { (socket.response as? HTTPURLResponse)?.statusCode }

    public init(request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 25
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 2_097_152
    }
    public func resume() { socket.resume() }
    public func receive() async throws -> Data {
        switch try await socket.receive() {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: return Data()
        }
    }
    public func send(_ data: Data) async throws {
        guard let json = String(data: data, encoding: .utf8) else { throw LiveError.transport("Ungültiges JSON-Ereignis.") }
        try await socket.send(.string(json))
    }
    public func ping() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            socket.sendPing { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
    public func close() {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

@MainActor
public final class LiveConnection {
    public var onEvent: ((LiveEvent) -> Void)?
    public private(set) var ready = false
    public private(set) var finalized = false
    public private(set) var usageSeconds = 0.0
    public private(set) var roundTripMilliseconds: Double?
    private var socket: (any LiveTransport)?
    private let transportFactory: (URLRequest) -> any LiveTransport
    private let startupTimeout: Duration
    private let finalizationTimeout: Duration
    private var receiver: Task<Void, Never>?
    private var failure: Error?
    private var closing = false
    private var activeID = UUID()

    public init(transportFactory: @escaping (URLRequest) -> any LiveTransport = { URLSessionLiveTransport(request: $0) },
                startupTimeout: Duration = .seconds(25), finalizationTimeout: Duration = .seconds(15)) {
        self.transportFactory = transportFactory
        self.startupTimeout = startupTimeout
        self.finalizationTimeout = finalizationTimeout
    }

    public func start(apiKey: String, profile: TranslationProfile, voice: String, englishOnly: Bool) async throws {
        guard socket == nil else { throw LiveError.configuration("Eine Sitzung läuft bereits.") }
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.contains("\n"), !key.contains("\r") else {
            throw LiveError.configuration("Bitte einen gültigen OpenAI API-Key hinterlegen.")
        }
        failure = nil; ready = false; finalized = false; closing = false; usageSeconds = 0
        let id = UUID(); activeID = id
        var request = URLRequest(url: URL(string: "wss://api.openai.com/v1/live/sessions")!)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 25
        let socket = transportFactory(request)
        self.socket = socket
        socket.resume()
        receiver = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let data = try await socket.receive()
                    guard let self, self.activeID == id else { return }
                    let event = try LiveEvent.parse(data)
                    switch event {
                    case .started: self.ready = true
                    case .usage(let seconds): self.usageSeconds = seconds
                    case .closed(let seconds, _):
                        self.finalized = true; self.ready = false
                        if let seconds { self.usageSeconds = seconds }
                    case .error(let detail): self.failure = LiveError.transport(detail)
                    default: break
                    }
                    self.onEvent?(event)
                    if self.finalized { return }
                }
            } catch {
                guard let self, self.activeID == id, !Task.isCancelled, !self.finalized else { return }
                let detail: String
                if let status = socket.statusCode, status != 101 {
                    detail = "OpenAI-Verbindung abgelehnt (HTTP \(status)). API-Key, Projektzugriff und Guthaben prüfen."
                } else {
                    detail = "Die Live-Verbindung wurde unterbrochen: \(error.localizedDescription)"
                }
                self.failure = LiveError.transport(detail)
                self.ready = false
                self.onEvent?(.error(detail))
            }
        }
        do {
            try await sendData(profile.startEvent(voice: voice, englishOnly: englishOnly))
            let deadline = ContinuousClock.now + startupTimeout
            while !ready {
                try Task.checkCancellation()
                if let failure { throw failure }
                if finalized || closing || activeID != id { throw LiveError.transport("Sitzungsstart abgebrochen.") }
                guard ContinuousClock.now < deadline else { throw LiveError.timeout("GPT-Live antwortet nicht auf den Sitzungsstart.") }
                try await Task.sleep(for: .milliseconds(25))
            }
        } catch { abort(); throw error }
    }

    public func sendAudio(_ pcm: Data) async throws {
        guard ready, !closing else { throw LiveError.transport("Die Live-Sitzung nimmt kein Audio an.") }
        guard pcm.count.isMultiple(of: 2), pcm.count <= PCM.bytesPerSecond else {
            throw LiveError.audio("Ungültiger Audio-Sendeblock.")
        }
        try await sendObject(["type": "session.input_audio.append", "audio": pcm.base64EncodedString()])
    }

    public func rejectDelegation(id: String, instruction: String) async throws {
        try await sendObject(["type": "session.instructions.append", "event_id": UUID().uuidString,
                              "delegation_id": id, "content": instruction])
    }

    public func ping() async throws {
        guard let socket, ready else { return }
        let began = ContinuousClock.now
        try await socket.ping()
        let elapsed = began.duration(to: .now)
        roundTripMilliseconds = Double(elapsed.components.attoseconds) / 1e15
            + Double(elapsed.components.seconds) * 1_000
    }

    public func close() async throws {
        guard socket != nil else { return }
        defer { release() }
        if finalized { return }
        if !closing {
            closing = true
            if ready { try await sendObject(["type": "session.close", "event_id": UUID().uuidString]) }
            else { throw LiveError.transport("Sitzung ohne bestätigte Finalisierung beendet.") }
        }
        let deadline = ContinuousClock.now + finalizationTimeout
        while !finalized {
            if let failure { throw failure }
            guard ContinuousClock.now < deadline else {
                throw LiveError.timeout("OpenAI hat session.closed nicht bestätigt; finale Nutzung unbestätigt.")
            }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    public func abort() { release() }

    private func release() {
        activeID = UUID()
        ready = false
        receiver?.cancel(); receiver = nil
        socket?.close(); socket = nil
    }

    private func sendObject(_ object: [String: Any]) async throws {
        try await sendData(JSONSerialization.data(withJSONObject: object))
    }

    private func sendData(_ data: Data) async throws {
        guard let socket else {
            throw LiveError.transport("Die Verbindung ist geschlossen.")
        }
        try await socket.send(data)
    }
}
