import AppKit
import Combine
import LiveTranslateAudio
import LiveTranslateCore

struct AudioSource: Identifiable {
    let id: String
    let name: String
    let icon: NSImage?
}

@MainActor
final class SessionModel: ObservableObject {
    static let shared = SessionModel()
    enum Phase { case idle, testing, preparing, connecting, running, stopping, failed }
    @Published private(set) var phase: Phase = .idle
    @Published var errorMessage: String?
    @Published var notice: String?
    @Published var selectedSource = "system"
    @Published var voice = "meridian"
    @Published var englishOnly = true
    @Published var volume = 0.85 { didSet { playback?.volume = Float(volume) } }
    @Published var showOverlay = false { didSet { overlay.setVisible(showOverlay, model: self) } }
    @Published var showSource = true
    @Published var hasKey = false
    @Published var sources: [AudioSource] = []
    @Published private(set) var timeline = CaptionTimeline()
    @Published private(set) var inputLevel = 0.0
    @Published private(set) var outputLevel = 0.0
    @Published private(set) var inputBufferMs = 0.0
    @Published private(set) var outputBufferMs = 0.0
    @Published private(set) var roundTripMs: Double?
    @Published private(set) var elapsed = 0.0
    @Published private(set) var billedSeconds = 0.0
    @Published private(set) var finalized = false
    @Published private(set) var receivedSamples = 0
    @Published private(set) var outputSamples = 0
    @Published var maxMinutes = 60
    let profile: TranslationProfile?
    private let overlay = CaptionWindow()
    private var connection: LiveConnection?
    private var capture: SystemAudioCapture?
    private var playback: AudioPlayback?
    private var inputQueue = PCMQueue()
    private var generation = UUID()
    private var startTask: Task<Void, Never>?
    private var pump: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var captureTestTask: Task<Void, Never>?
    private var sessionStart: Date?
    private var lastMeterUpdate = Date.distantPast
    private var lastInputRMS = 0.0
    private var delegationCount = 0
    private var sleepObserver: NSObjectProtocol?

    var isBusy: Bool { [.testing, .preparing, .connecting, .running, .stopping].contains(phase) }
    var canStart: Bool { !isBusy && hasKey && profile != nil }
    var status: String {
        switch phase {
        case .idle: "Bereit"
        case .testing: "Audioquelle lokal prüfen …"
        case .preparing: "Audiozugriff vorbereiten …"
        case .connecting: "GPT-Live verbinden …"
        case .running: inputLevel > 0.008 ? "Übersetzung läuft" : "Hört auf den Quellton"
        case .stopping: "Übersetzung abschließen …"
        case .failed: "Sitzung angehalten"
        }
    }

    init() {
        profile = try? TranslationProfile.bundled()
        do { hasKey = try KeychainStore.read() != nil } catch { errorMessage = error.localizedDescription }
        voice = UserDefaults.standard.string(forKey: "voice") ?? profile?.defaultVoice ?? "meridian"
        if profile?.voices.contains(voice) != true { voice = "meridian" }
        refreshSources()
        sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in await SessionModel.shared.stop() }
        }
    }

    func refreshSources() {
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && $0.bundleIdentifier != Bundle.main.bundleIdentifier
        }
        var seen = Set<String>()
        sources = apps.compactMap { app in
            guard let id = app.bundleIdentifier, seen.insert(id).inserted else { return nil }
            return AudioSource(id: id, name: app.localizedName ?? id, icon: app.icon)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func saveKey(_ key: String) throws { try KeychainStore.save(key); hasKey = true }

    func importKey() {
        let panel = NSOpenPanel()
        panel.message = "Eine lokale .env-Datei mit OPENAI_API_KEY auswählen. Nur dieser Schlüssel wird in den macOS-Schlüsselbund übernommen."
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let contents = try String(contentsOf: url, encoding: .utf8)
            guard let line = contents.components(separatedBy: .newlines).first(where: { $0.hasPrefix("OPENAI_API_KEY=") }) else {
                throw LiveError.configuration("Die Datei enthält keinen OPENAI_API_KEY.")
            }
            let value = String(line.dropFirst("OPENAI_API_KEY=".count)).trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            try saveKey(value)
        } catch { errorMessage = error.localizedDescription }
    }

    func start() {
        guard canStart else { return }
        let id = UUID(); generation = id
        errorMessage = nil; notice = nil; phase = .preparing
        timeline = CaptionTimeline(); inputQueue.removeAll()
        inputLevel = 0; outputLevel = 0; inputBufferMs = 0; outputBufferMs = 0
        receivedSamples = 0; outputSamples = 0; elapsed = 0; billedSeconds = 0; finalized = false
        delegationCount = 0; roundTripMs = nil
        UserDefaults.standard.set(voice, forKey: "voice")
        let source = selectedSource == "system" ? nil : selectedSource
        startTask = Task { [weak self] in
            guard let self, let profile = self.profile else { return }
            let connection = LiveConnection()
            let capture = SystemAudioCapture(onAudio: { [weak self] pcm, rms in
                Task { @MainActor in self?.receiveInput(pcm, rms: rms, generation: id) }
            }, onError: { [weak self] detail in
                Task { @MainActor in
                    guard let self, self.generation == id, self.phase != .stopping else { return }
                    await self.stop(error: detail)
                }
            })
            self.capture = capture; self.connection = connection
            connection.onEvent = { [weak self] event in self?.receive(event, generation: id) }
            do {
                guard let apiKey = try KeychainStore.read() else { throw LiveError.configuration("Kein API-Key hinterlegt.") }
                try await capture.prepare(bundleIdentifier: source)
                try Task.checkCancellation()
                guard self.generation == id else { throw CancellationError() }
                self.phase = .connecting
                let playback = AudioPlayback(); playback.volume = Float(self.volume)
                try playback.start(); self.playback = playback
                try await connection.start(apiKey: apiKey, profile: profile, voice: self.voice, englishOnly: self.englishOnly)
                try Task.checkCancellation()
                guard self.generation == id else { throw CancellationError() }
                try await capture.start()
                try Task.checkCancellation()
                guard self.generation == id else { throw CancellationError() }
                self.phase = .running; self.sessionStart = Date()
                self.startPump(generation: id, connection: connection)
            } catch {
                await capture.stop()
                if connection.ready { try? await connection.close() } else { connection.abort() }
                guard self.generation == id, self.phase != .stopping else { return }
                self.playback?.stop(); self.playback = nil
                self.phase = .failed
                self.errorMessage = error is CancellationError ? "Start abgebrochen." : error.localizedDescription
            }
        }
    }

    private func receiveInput(_ data: Data, rms: Double, generation: UUID) {
        if self.generation == generation, phase == .testing {
            receivedSamples += data.count / 2
            inputLevel = rms
            lastInputRMS = max(lastInputRMS, rms)
            return
        }
        guard self.generation == generation, [.running, .connecting].contains(phase) else { return }
        do { try inputQueue.append(data); receivedSamples += data.count / 2; lastInputRMS = rms }
        catch { Task { await stop(error: error.localizedDescription) } }
    }

    private func startPump(generation: UUID, connection: LiveConnection) {
        pump = Task { [weak self] in
            var next = ContinuousClock.now
            while !Task.isCancelled {
                guard let self, self.generation == generation, self.phase == .running else { return }
                do {
                    guard let frame = self.inputQueue.readFrame() else { return }
                    self.lastInputRMS = PCM.rms(try PCM.decode(frame))
                    let began = ContinuousClock.now
                    try await connection.sendAudio(frame)
                    guard began.duration(to: .now) < .milliseconds(500) else {
                        throw LiveError.transport("Das Netzwerk überträgt Audio zu langsam. Bitte Verbindung prüfen und neu starten.")
                    }
                    let now = Date()
                    if now.timeIntervalSince(self.lastMeterUpdate) >= 0.1 {
                        self.lastMeterUpdate = now
                        self.inputLevel = self.lastInputRMS
                        self.outputLevel = self.playback?.outputRMS ?? 0
                        self.inputBufferMs = self.inputQueue.milliseconds
                        self.outputBufferMs = (self.playback?.queuedSeconds ?? 0) * 1_000
                        self.elapsed = now.timeIntervalSince(self.sessionStart ?? now)
                        if self.elapsed >= Double(self.maxMinutes * 60) {
                            Task { await self.stop(error: "Das gewählte Sitzungslimit wurde erreicht.") }; return
                        }
                    }
                    next = max(next.advanced(by: .milliseconds(20)), .now)
                    try await Task.sleep(until: next, clock: .continuous)
                } catch {
                    guard !Task.isCancelled, self.phase == .running else { return }
                    Task { await self.stop(error: error.localizedDescription) }; return
                }
            }
        }
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self, self.generation == generation, self.phase == .running else { return }
                do { try await connection.ping(); self.roundTripMs = connection.roundTripMilliseconds }
                catch { await self.stop(error: "Die Netzwerkverbindung antwortet nicht mehr."); return }
            }
        }
    }

    private func receive(_ event: LiveEvent, generation: UUID) {
        guard self.generation == generation else { return }
        switch event {
        case .audio(let data):
            do { try playback?.append(data); outputSamples += data.count / 2 }
            catch { Task { await stop(error: error.localizedDescription) } }
        case .transcript(let lane, let text, let start, let end):
            timeline.append(lane: lane, text: text, start: start, end: end)
        case .usage(let seconds): billedSeconds = seconds
        case .closed(let seconds, let reason):
            finalized = true
            if let seconds { billedSeconds = seconds }
            if phase == .running { Task { await stop(error: "GPT-Live hat die Sitzung beendet (\(reason)).") } }
        case .delegation(let id):
            delegationCount += 1
            guard delegationCount <= 2, let profile, let connection else {
                Task { await stop(error: "Das Modell verlässt wiederholt den Übersetzungsmodus. Bitte neu starten.") }; return
            }
            Task {
                do { try await connection.rejectDelegation(id: id, instruction: profile.delegationRecovery) }
                catch { await stop(error: error.localizedDescription) }
            }
        case .error(let detail):
            if phase == .running { Task { await stop(error: detail) } }
            else if phase != .stopping { errorMessage = detail }
        default: break
        }
    }

    func stop(error: String? = nil) async {
        guard phase != .stopping else { return }
        guard isBusy || connection != nil else { if let error { errorMessage = error }; return }
        phase = .stopping
        startTask?.cancel(); pump?.cancel(); pingTask?.cancel(); captureTestTask?.cancel()
        pump = nil; pingTask = nil
        await capture?.stop(); capture = nil
        var failure = error
        if let connection {
            do { try await connection.close() } catch { failure = failure ?? error.localizedDescription }
            billedSeconds = connection.usageSeconds; finalized = connection.finalized
        }
        await playback?.drain(); playback?.stop(); playback = nil
        generation = UUID(); connection = nil; inputQueue.removeAll()
        inputLevel = 0; outputLevel = 0; inputBufferMs = 0; outputBufferMs = 0
        errorMessage = failure; phase = failure == nil ? .idle : .failed
    }

    func testCapture() {
        guard !isBusy else { return }
        let id = UUID(); generation = id
        phase = .testing; errorMessage = nil; notice = nil; receivedSamples = 0; lastInputRMS = 0
        let source = selectedSource == "system" ? nil : selectedSource
        let capture = SystemAudioCapture(onAudio: { [weak self] data, rms in
            Task { @MainActor in self?.receiveInput(data, rms: rms, generation: id) }
        }, onError: { [weak self] message in
            Task { @MainActor in
                guard let self, self.generation == id, self.phase == .testing else { return }
                await self.stop(error: message)
            }
        })
        self.capture = capture
        captureTestTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await capture.prepare(bundleIdentifier: source)
                try Task.checkCancellation()
                try await capture.start()
                try await Task.sleep(for: .seconds(10))
                guard self.generation == id else { await capture.stop(); return }
                let samples = self.receivedSamples
                let audible = self.lastInputRMS > 0.002
                await self.stop()
                self.notice = audible
                    ? "Systemton bestätigt: \(samples) Audiosamples empfangen. Der Test hat kein Audio an OpenAI gesendet."
                    : "Audiozugriff geprüft, aber kein hörbarer Quellton empfangen. Starte Ton in der gewählten App und teste erneut."
            } catch {
                await capture.stop()
                guard self.generation == id, !Task.isCancelled else { return }
                await self.stop(error: error.localizedDescription)
            }
        }
    }

    func exportTranscript() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "Live-Translate.txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let text = timeline.captions.map { caption in
            let stamp = caption.start.map { String(format: "[%.2fs] ", $0 / 1_000) } ?? ""
            return stamp + (caption.lane == .source ? "Quelle: " : "Deutsch: ") + caption.text
        }.joined(separator: "\n\n")
        do { try text.write(to: url, atomically: true, encoding: .utf8) }
        catch { errorMessage = error.localizedDescription }
    }
}
