import Foundation
import Testing
import LiveTranslateCore
@testable import LiveTranslateAudio
import AVFoundation

@Test func autoDubbingKeepsOriginalUntilTranslationIsAudible() {
    var mix = SourceMix()
    mix.sourceSpeaking = true
    #expect(mix.gain == 1)
    mix.translationAudible = true
    #expect(abs(mix.gain - 0.28) < 0.001)
    mix.sourceSpeaking = false
    #expect(abs(mix.gain - 0.6) < 0.001)
    mix.volume = 0.5
    #expect(abs(mix.gain - 0.3) < 0.001)
    mix.ducking = false
    #expect(mix.gain == 0.5)
    mix.muted = true
    #expect(mix.gain == 0)
    mix.muted = false; mix.volume = .nan
    #expect(mix.gain.isFinite)
}

@Test func rampsAreSmoothAndEventuallyReachMuteAndUnity() {
    var ramp = GainRamp()
    let first = ramp.advance(toward: 0, sampleRate: 48_000)
    #expect(first > 0.99 && first < 1)
    for _ in 0..<1_500 { _ = ramp.advance(toward: 0, sampleRate: 48_000) }
    #expect(ramp.value == 0)
    for _ in 0..<8_700 { _ = ramp.advance(toward: 1, sampleRate: 48_000) }
    #expect(ramp.value == 1)
}

@Test func neuralDecisionBridgesPausesButDoesNotStickOnAmbiguousAudio() {
    var detector = SpeechDecision()
    detector.update(0.6); #expect(!detector.speaking)
    detector.update(0.6); #expect(detector.speaking)
    for _ in 0..<22 { detector.update(0.5) }
    #expect(detector.speaking)
    detector.update(0.5); #expect(!detector.speaking)
    detector.update(0.9); #expect(detector.speaking)
    for _ in 0..<12 { detector.update(.nan) }
    #expect(!detector.speaking)
}

@Test func bundledSileroReallyRunsAndDoesNotCallSilenceSpeech() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let detector = try NeuralVAD(modelURL: root.appendingPathComponent("public/vad/silero_vad_16k_op15.onnx"))
    for _ in 0..<100 { #expect(try !detector.process([Float](repeating: 0, count: 480))) }
    #expect(detector.inferenceCount >= 60)
    #expect(detector.probability < 0.48)
}

@Test func interleavedStereoIsPreservedWithoutMutatingRecognitionInput() throws {
    let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2))
    buffer.frameLength = 2
    let samples: [Float] = [0.1, -0.2, 0.3, -0.4]
    samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: 4) }
    var ramp = GainRamp()
    let output = try #require(sourceOutput(buffer, gain: 1, ramp: &ramp))
    #expect(!output.format.isInterleaved)
    #expect(output.floatChannelData![0][0] == 0.1)
    #expect(output.floatChannelData![1][1] == -0.4)
    #expect(Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: 4)) == samples)
}

@Test func mutingOriginalLeavesUnattenuatedApiSamplesIntact() throws {
    let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2_000))
    buffer.frameLength = 2_000
    for channel in 0..<2 { for frame in 0..<2_000 { buffer.floatChannelData![channel][frame] = 0.25 } }
    var ramp = GainRamp()
    let output = try #require(sourceOutput(buffer, gain: 0, ramp: &ramp))
    #expect(output.floatChannelData![0][0] > 0.24)
    #expect(output.floatChannelData![0][1_999] == 0)
    #expect(output.floatChannelData![1][1_999] == 0)
    #expect(buffer.floatChannelData![0][1_999] == 0.25)
}
