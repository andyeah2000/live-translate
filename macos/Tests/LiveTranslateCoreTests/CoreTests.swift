import Foundation
import Testing
@testable import LiveTranslateCore

@Test func pcmEncodingIsLittleEndianAndFinite() throws {
    let encoded = PCM.encode([-1, 0, 0.5, 1, .nan, .infinity])
    #expect(Array(encoded) == [0, 128, 0, 0, 0, 64, 255, 127, 0, 0, 0, 0])
    #expect(try PCM.decode(encoded)[2] == 0.5)
    #expect(throws: LiveError.self) { try PCM.decode(Data([1])) }
}

@Test func arbitraryCaptureChunksPreserveEverySample() throws {
    let samples = (0..<4800).map { Float($0 % 100) / 100 - 0.5 }
    let encoded = PCM.encode(samples)
    var queue = PCMQueue(maxMilliseconds: 300)
    for index in stride(from: 0, to: encoded.count, by: 126) {
        try queue.append(Data(encoded[index..<min(encoded.count, index + 126)]))
    }
    var output = Data()
    while let frame = queue.readFrame(padSilence: false) { output.append(frame) }
    #expect(output == encoded)
    #expect(queue.byteCount == 0)
}

@Test func emptyInputProducesClockedSilenceAndOverloadIsExplicit() throws {
    var queue = PCMQueue(maxMilliseconds: 20)
    #expect(queue.readFrame() == PCM.silence)
    try queue.append(Data([1, 2]))
    let frame = queue.readFrame()!
    #expect(frame.count == 960)
    #expect(frame.prefix(2) == Data([1, 2]))
    #expect(throws: LiveError.self) { try queue.append(Data(count: 962)) }
    #expect(queue.byteCount == 0)
}

@Test func profileUsesLiveAndCannotLaunchWebSearch() throws {
    let profile = try TranslationProfile.bundled()
    let event = try JSONSerialization.jsonObject(with: profile.startEvent(voice: "meridian", englishOnly: true)) as! [String: Any]
    let session = event["session"] as! [String: Any]
    #expect(event["type"] as? String == "session.start")
    #expect(session["model"] as? String == "gpt-live-1")
    #expect(session["store"] as? Bool == false)
    #expect((session["delegation"] as? [String: String]) == ["type": "client"])
    #expect(throws: LiveError.self) { try profile.startEvent(voice: "unexpected", englishOnly: true) }
    #expect(profile.prompt(englishOnly: false).contains(profile.automaticInstructions))
    #expect(!profile.prompt(englishOnly: false).contains(profile.englishOnlyInstructions))
}

@Test func transcriptsPreserveWhitespaceAndSeparateTimelines() throws {
    let data = Data(#"{"type":"session.output_transcript.delta","delta":" Welt ","start_ms":10,"end_ms":200}"#.utf8)
    guard case .transcript(let lane, let text, let start, let end) = try LiveEvent.parse(data) else { Issue.record("Missing transcript"); return }
    #expect(lane == .target); #expect(text == " Welt "); #expect(start == 10); #expect(end == 200)
    var captions = CaptionTimeline()
    captions.append(lane: .target, text: "Hallo", start: 0, end: 10)
    captions.append(lane: .source, text: "Hello", start: 0, end: 100)
    captions.append(lane: lane, text: text, start: start, end: end)
    #expect(captions.latest(.target) == "Hallo Welt ")
    captions.append(lane: .target, text: "Neuer Satz", start: 2000, end: 2200)
    #expect(captions.captions.count == 3)
}

@Test func usageIsACumulativeSnapshotAndCloseHasAReason() throws {
    guard case .usage(let seconds) = try LiveEvent.parse(Data(#"{"type":"session.usage.updated","usage":{"seconds":15}}"#.utf8)) else { Issue.record("Missing usage"); return }
    #expect(seconds == 15)
    guard case .closed(let final, let reason) = try LiveEvent.parse(Data(#"{"type":"session.closed","usage":{"seconds":16},"reason":"close_requested"}"#.utf8)) else { Issue.record("Missing close"); return }
    #expect(final == 16); #expect(reason == "close_requested")
    #expect(throws: LiveError.self) { try LiveEvent.parse(Data(#"{"type":"session.output_audio.delta","delta":"AQ=="}"#.utf8)) }
}

@Test func playbackRateIsBoundedAndRecoversNaturally() {
    #expect(PlaybackPolicy.rate(queuedSeconds: 0.1) == 1)
    #expect(PlaybackPolicy.rate(queuedSeconds: 1) > 1)
    #expect(PlaybackPolicy.rate(queuedSeconds: 100) <= 1.12)
    #expect(PlaybackPolicy.rate(queuedSeconds: 0) == 1)
}
