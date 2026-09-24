import AVFoundation
import Foundation
import LiveTranslateAudio
import LiveTranslateCore

@main
struct LiveTranslateProbe {
    @MainActor
    static func main() async {
        do { try await run() }
        catch { print("PROBE FAILED: \(error.localizedDescription)"); exit(1) }
    }

    @MainActor
    static func run() async throws {
        let args = CommandLine.arguments
        func option(_ name: String) -> String? {
            guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
            return args[index + 1]
        }
        if args.contains("--vad-test") {
            guard let path = option("--file"), let modelPath = option("--vad-model") else {
                throw LiveError.configuration("Für den lokalen VAD-Test --file und --vad-model angeben.")
            }
            let vad = try NeuralVAD(modelURL: URL(fileURLWithPath: modelPath))
            let samples = try PCM.decode(loadPCM(URL(fileURLWithPath: path)))
            var maximum: Float = 0; var speechBlocks = 0
            let began = Date()
            for index in stride(from: 0, to: samples.count, by: 480) {
                if try vad.process(Array(samples[index..<min(index + 480, samples.count)])) { speechBlocks += 1 }
                maximum = max(maximum, vad.probability)
            }
            print("Silero: \(vad.inferenceCount) Inferenzen, \(speechBlocks) Sprachblöcke, maximale Wahrscheinlichkeit \(maximum), Rechenzeit \(Date().timeIntervalSince(began)) s.")
            guard speechBlocks > 0 else { throw LiveError.audio("Keine Sprache im Testclip erkannt.") }
            return
        }
        if args.contains("--audio-self-test") {
            let output = AudioPlayback()
            try output.start()
            let samples = (0..<12_000).map { Float(sin(Double($0) * 2 * .pi * 440 / 24_000)) * 0.03 }
            try output.append(PCM.encode(samples))
            await output.drain()
            let played = output.playedFrames
            output.stop()
            guard played == samples.count else { throw LiveError.audio("Audioausgabe spielte nicht alle Testframes.") }
            print("Native Audioausgabe: \(played) Frames abgespielt.")
            return
        }
        guard args.contains("--live-test") else {
            print("LiveTranslateProbe --audio-self-test | --live-test [--file speech.wav] [--output result.wav] [--report metrics.json]")
            return
        }
        guard let key = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], !key.isEmpty else {
            throw LiveError.configuration("Für den API-Test OPENAI_API_KEY in der Prozessumgebung setzen.")
        }
        let profile = try TranslationProfile.bundled()
        let connection = LiveConnection()
        let pcm = try option("--file").map { try loadPCM(URL(fileURLWithPath: $0)) } ?? Data(count: PCM.bytesPerSecond * 2)
        guard pcm.count <= PCM.bytesPerSecond * 45 else { throw LiveError.configuration("Testclips dürfen höchstens 45 Sekunden lang sein.") }
        var output = Data()
        var timeline = CaptionTimeline()
        var eventError: String?
        var firstInput: Date?
        var firstOutput: Date?
        var sourceDeltaCount = 0
        var targetDeltaCount = 0
        var maxOutputRMS = 0.0
        var delegations = 0
        connection.onEvent = { event in
            switch event {
            case .audio(let data):
                output.append(data)
                let rms = PCM.rms((try? PCM.decode(data)) ?? [])
                maxOutputRMS = max(maxOutputRMS, rms)
                if rms > 0.002, firstOutput == nil { firstOutput = Date() }
            case .transcript(let lane, let text, let start, let end):
                timeline.append(lane: lane, text: text, start: start, end: end)
                if lane == .target { targetDeltaCount += 1 } else { sourceDeltaCount += 1 }
            case .delegation(let id):
                delegations += 1
                Task { try? await connection.rejectDelegation(id: id, instruction: profile.delegationRecovery) }
            case .error(let error): eventError = error
            default: break
            }
        }
        let began = Date()
        try await connection.start(apiKey: key, profile: profile, voice: profile.defaultVoice, englishOnly: true)
        let connectMs = Date().timeIntervalSince(began) * 1_000
        print("GPT-Live: session.started bestätigt. Testaudio wird in Echtzeit gesendet.")
        do {
            var queue = PCMQueue(maxMilliseconds: 60_000)
            try queue.append(pcm)
            let sourceFrames = Int(ceil(Double(pcm.count) / Double(PCM.frameBytes)))
            let tailFrames = option("--file") == nil ? 0 : 500
            var next = ContinuousClock.now
            for _ in 0..<(sourceFrames + tailFrames) {
                if let eventError { throw LiveError.transport(eventError) }
                let frame = queue.readFrame()!
                if firstInput == nil, PCM.rms(try PCM.decode(frame)) > 0.002 { firstInput = Date() }
                try await connection.sendAudio(frame)
                next = next.advanced(by: .milliseconds(20))
                try await Task.sleep(until: next, clock: .continuous)
            }
            try await connection.close()
        } catch {
            if connection.ready { try? await connection.close() }
            connection.abort(); throw error
        }
        let report: [String: Any] = [
            "model": profile.model, "voice": profile.defaultVoice, "transport": "native-websocket",
            "sessionFinalized": connection.finalized, "usageSeconds": connection.usageSeconds,
            "connectMilliseconds": connectMs,
            "firstNonSilentOutputMillisecondsFromInput": firstInput.flatMap { input in firstOutput.map { $0.timeIntervalSince(input) * 1_000 } } as Any? ?? NSNull(),
            "inputAudioSeconds": Double(pcm.count) / Double(PCM.bytesPerSecond),
            "outputAudioSeconds": Double(output.count) / Double(PCM.bytesPerSecond),
            "maximumOutputRMS": maxOutputRMS,
            "sourceTranscriptDeltas": sourceDeltaCount, "targetTranscriptDeltas": targetDeltaCount,
            "delegationsBlocked": delegations,
            "transcript": timeline.captions.map { ["lane": $0.lane.rawValue, "text": $0.text] },
            "scope": "synthetic test audio; first-packet timing is not semantic translation lag; human listening review required"
        ]
        let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        if let path = option("--report") { try json.write(to: URL(fileURLWithPath: path), options: .atomic) }
        if let path = option("--output") { try writeWAV(output, to: URL(fileURLWithPath: path)) }
        print(String(data: json, encoding: .utf8)!)
        if option("--file") != nil, (maxOutputRMS < 0.002 || targetDeltaCount == 0) {
            throw LiveError.audio("Die API lieferte keinen nachgewiesenen Zielton mit Transkript.")
        }
    }

    static func loadPCM(_ url: URL) throws -> Data {
        let file = try AVAudioFile(forReading: url)
        guard file.length > 0, Double(file.length) / file.processingFormat.sampleRate <= 45,
              let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              let format = AVAudioFormat(standardFormatWithSampleRate: Double(PCM.sampleRate), channels: 1),
              let converter = AVAudioConverter(from: file.processingFormat, to: format),
              let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(ceil(Double(file.length) * Double(PCM.sampleRate) / file.processingFormat.sampleRate)) + 64) else {
            throw LiveError.audio("Testaudio konnte nicht geöffnet werden oder ist länger als 45 Sekunden.")
        }
        try file.read(into: input)
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .endOfStream; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error { throw error }
        guard let pointer = output.floatChannelData?[0] else { throw LiveError.audio("Testaudio fehlt.") }
        return PCM.encode(Array(UnsafeBufferPointer(start: pointer, count: Int(output.frameLength))))
    }

    static func writeWAV(_ pcm: Data, to url: URL) throws {
        var data = Data()
        func text(_ value: String) { data.append(contentsOf: value.utf8) }
        func int(_ value: UInt32) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
        text("RIFF"); int(UInt32(pcm.count + 36)); text("WAVEfmt "); int(16)
        data.append(contentsOf: [1, 0, 1, 0]); int(UInt32(PCM.sampleRate)); int(UInt32(PCM.bytesPerSecond))
        data.append(contentsOf: [2, 0, 16, 0]); text("data"); int(UInt32(pcm.count)); data.append(pcm)
        try data.write(to: url, options: .atomic)
    }
}
