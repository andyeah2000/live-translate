import AVFoundation
import OnnxRuntimeBindings
import LiveTranslateCore

/// Called only on the capture DSP queue. State is reset for every new session.
public final class NeuralVAD {
    private let environment: ORTEnv
    private let session: ORTSession
    private var state: ORTValue
    private var context = [Float](repeating: 0, count: 64)
    private var pending: [Float] = []
    private let inputFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
    private let outputFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    private let converter: AVAudioConverter
    private var detector = SpeechDecision()
    public private(set) var probability: Float = 0
    public private(set) var inferenceCount = 0

    public init(modelURL: URL? = nil) throws {
        guard let url = modelURL ?? Bundle.main.url(forResource: "silero_vad_16k_op15", withExtension: "onnx") else {
            throw LiveError.audio("Das Modell für neuronales Auto-Dubbing fehlt. Bitte die vollständige App installieren.")
        }
        environment = try ORTEnv(loggingLevel: .error)
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(1)
        session = try ORTSession(env: environment, modelPath: url.path, sessionOptions: options)
        state = try Self.tensor([Float](repeating: 0, count: 256), shape: [2, 1, 128])
        converter = AVAudioConverter(from: inputFormat, to: outputFormat)!
        _ = try infer([Float](repeating: 0, count: 512))
        state = try Self.tensor([Float](repeating: 0, count: 256), shape: [2, 1, 128])
        context = [Float](repeating: 0, count: 64); inferenceCount = 0
    }

    public func process(_ samples: [Float]) throws -> Bool {
        guard !samples.isEmpty else { return detector.speaking }
        guard let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count)),
              let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(ceil(Double(samples.count) * 2 / 3)) + 64) else {
            throw LiveError.audio("Neuraler Audiopuffer konnte nicht angelegt werden.")
        }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        var supplied = false; var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return input
        }
        if let error { throw error }
        pending.append(contentsOf: UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
        var offset = 0
        while pending.count - offset >= 512 {
            probability = try infer(Array(pending[offset..<offset + 512]))
            detector.update(Double(probability)); offset += 512
        }
        if offset > 0 { pending.removeFirst(offset) }
        return detector.speaking
    }

    private func infer(_ samples: [Float]) throws -> Float {
        var rate: Int64 = 16_000
        let rateData = withUnsafeBytes(of: &rate) { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
        let outputs = try session.run(withInputs: [
            "input": Self.tensor(context + samples, shape: [1, 576]),
            "state": state,
            "sr": ORTValue(tensorData: rateData, elementType: .int64, shape: [])
        ], outputNames: ["output", "stateN"], runOptions: nil)
        guard let output = outputs["output"], let next = outputs["stateN"] else { throw LiveError.audio("Silero lieferte keine vollständige Entscheidung.") }
        let data = try output.tensorData() as Data
        guard data.count == MemoryLayout<Float>.size else { throw LiveError.audio("Silero lieferte ein ungültiges Ergebnis.") }
        let value = data.withUnsafeBytes { $0.loadUnaligned(as: Float.self) }
        guard value.isFinite else { throw LiveError.audio("Silero lieferte eine ungültige Wahrscheinlichkeit.") }
        state = next; context = Array(samples.suffix(64)); inferenceCount += 1
        return value
    }

    private static func tensor(_ values: [Float], shape: [NSNumber]) throws -> ORTValue {
        let data = values.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
        return try ORTValue(tensorData: data, elementType: .float, shape: shape)
    }
}
