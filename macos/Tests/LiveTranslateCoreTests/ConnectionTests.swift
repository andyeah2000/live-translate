import Foundation
import Testing
@testable import LiveTranslateCore

@MainActor
private final class FakeTransport: LiveTransport {
    var statusCode: Int? = 101
    var sent: [[String: Any]] = []
    var closed = false
    var failSending = false
    private var pending: CheckedContinuation<Data, Error>?
    private var events: [Data] = []
    func resume() {}
    func send(_ data: Data) async throws {
        if failSending { throw LiveError.transport("Test: send failed") }
        sent.append(try JSONSerialization.jsonObject(with: data) as! [String: Any])
    }
    func receive() async throws -> Data {
        if !events.isEmpty { return events.removeFirst() }
        if closed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func emit(_ json: String) {
        if let continuation = pending { pending = nil; continuation.resume(returning: Data(json.utf8)) }
        else { events.append(Data(json.utf8)) }
    }
    func ping() async throws {}
    func close() { closed = true; pending?.resume(throwing: CancellationError()); pending = nil }
}

@MainActor @Test func liveLifecycleWaitsForReadinessAndFinalUsage() async throws {
    let transport = FakeTransport()
    let connection = LiveConnection(transportFactory: { request in
        #expect(request.url?.absoluteString == "wss://api.openai.com/v1/live/sessions")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer local-test")
        return transport
    })
    let profile = try TranslationProfile.bundled()
    let start = Task { try await connection.start(apiKey: "local-test", profile: profile, voice: "meridian", englishOnly: true) }
    try await Task.sleep(for: .milliseconds(10))
    #expect(!connection.ready)
    await #expect(throws: LiveError.self) { try await connection.sendAudio(PCM.silence) }
    #expect(transport.sent.count == 1)
    transport.emit(#"{"type":"session.started"}"#)
    try await start.value
    try await connection.sendAudio(PCM.silence)
    #expect(transport.sent.last?["type"] as? String == "session.input_audio.append")
    #expect(Data(base64Encoded: transport.sent.last?["audio"] as! String) == PCM.silence)
    transport.emit(#"{"type":"session.usage.updated","usage":{"seconds":12}}"#)
    transport.emit(#"{"type":"session.usage.updated","usage":{"seconds":15}}"#)
    try await Task.sleep(for: .milliseconds(5))
    #expect(connection.usageSeconds == 15)
    let finish = Task { try await connection.close() }
    try await Task.sleep(for: .milliseconds(5))
    #expect(!transport.closed)
    #expect(transport.sent.last?["type"] as? String == "session.close")
    transport.emit(#"{"type":"session.closed","reason":"close_requested","usage":{"seconds":16}}"#)
    try await finish.value
    #expect(transport.closed); #expect(connection.finalized); #expect(connection.usageSeconds == 16)
}

@MainActor @Test func noCreditsDoesNotLeaveAnOpenOrReadySession() async throws {
    let transport = FakeTransport()
    transport.emit(#"{"type":"error","error":{"code":"insufficient_quota","message":"You have no credits remaining."}}"#)
    let connection = LiveConnection(transportFactory: { _ in transport })
    await #expect(throws: LiveError.self) {
        try await connection.start(apiKey: "local-test", profile: TranslationProfile.bundled(), voice: "meridian", englishOnly: true)
    }
    #expect(transport.closed); #expect(!connection.ready); #expect(!connection.finalized)
    #expect(transport.sent.count == 1)
}

@MainActor @Test func timeoutsReleaseTransportsWithoutClaimingFinalization() async throws {
    let startingTransport = FakeTransport()
    let starting = LiveConnection(transportFactory: { _ in startingTransport }, startupTimeout: .milliseconds(5))
    await #expect(throws: LiveError.self) {
        try await starting.start(apiKey: "local-test", profile: TranslationProfile.bundled(), voice: "meridian", englishOnly: true)
    }
    #expect(startingTransport.closed)
    let transport = FakeTransport()
    transport.emit(#"{"type":"session.started"}"#)
    let connection = LiveConnection(transportFactory: { _ in transport }, finalizationTimeout: .milliseconds(5))
    try await connection.start(apiKey: "local-test", profile: TranslationProfile.bundled(), voice: "meridian", englishOnly: true)
    await #expect(throws: LiveError.self) { try await connection.close() }
    #expect(transport.closed); #expect(!connection.finalized)
}

@MainActor @Test func translationDelegationReturnsInstructionsWithoutRunningTools() async throws {
    let transport = FakeTransport()
    transport.emit(#"{"type":"session.started"}"#)
    let connection = LiveConnection(transportFactory: { _ in transport })
    let profile = try TranslationProfile.bundled()
    try await connection.start(apiKey: "local-test", profile: profile, voice: "meridian", englishOnly: true)
    try await connection.rejectDelegation(id: "delegation-test", instruction: profile.delegationRecovery)
    #expect(transport.sent.last?["type"] as? String == "session.instructions.append")
    #expect(transport.sent.last?["delegation_id"] as? String == "delegation-test")
    #expect(!transport.sent.contains { ($0["type"] as? String)?.hasPrefix("response.") == true })
    connection.abort()
}

@MainActor @Test func failedCloseSendReleasesSocketAndDoesNotClaimFinalization() async throws {
    let transport = FakeTransport()
    transport.emit(#"{"type":"session.started"}"#)
    let connection = LiveConnection(transportFactory: { _ in transport })
    try await connection.start(apiKey: "local-test", profile: TranslationProfile.bundled(), voice: "meridian", englishOnly: true)
    transport.failSending = true
    await #expect(throws: LiveError.self) { try await connection.close() }
    #expect(transport.closed); #expect(!connection.ready); #expect(!connection.finalized)
}

@MainActor @Test func cancellingFinalizationStillReleasesSocket() async throws {
    let transport = FakeTransport()
    transport.emit(#"{"type":"session.started"}"#)
    let connection = LiveConnection(transportFactory: { _ in transport })
    try await connection.start(apiKey: "local-test", profile: TranslationProfile.bundled(), voice: "meridian", englishOnly: true)
    let finish = Task { try await connection.close() }
    try await Task.sleep(for: .milliseconds(5))
    finish.cancel()
    await #expect(throws: CancellationError.self) { try await finish.value }
    #expect(transport.closed); #expect(!connection.finalized)
}
