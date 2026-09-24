import AVFoundation
import LiveTranslateCore

@MainActor
public final class AudioPlayback {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let format = AVAudioFormat(standardFormatWithSampleRate: Double(PCM.sampleRate), channels: 1)!
    private var scheduledFrames = 0
    private var startTask: Task<Void, Never>?
    private var generation = UUID()
    private let meter = PlaybackMeter()
    public var outputRMS: Double { meter.level }
    public private(set) var playedFrames = 0
    public private(set) var underruns = 0
    public var queuedSeconds: Double { Double(scheduledFrames) / Double(PCM.sampleRate) }
    public var rate: Float { timePitch.rate }
    public var volume: Float = 1 { didSet { player.volume = max(0, min(1, volume)) } }

    public init() {
        engine.attach(player); engine.attach(timePitch)
        engine.connect(player, to: timePitch, format: format)
        engine.connect(timePitch, to: engine.mainMixerNode, format: format)
        timePitch.pitch = 0
        timePitch.rate = 1
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 256, format: nil) { [meter] buffer, _ in
            meter.measure(buffer)
        }
    }

    public func start() throws { engine.prepare(); try engine.start() }

    public func append(_ data: Data) throws {
        let samples = try PCM.decode(data)
        guard !samples.isEmpty else { return }
        guard queuedSeconds + Double(samples.count) / Double(PCM.sampleRate) <= PlaybackPolicy.maximumSeconds else {
            throw LiveError.audio("Die Übersetzung liegt mehr als acht Sekunden zurück. Bitte die Quelle pausieren und neu starten.")
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channels = buffer.floatChannelData else { throw LiveError.audio("Der Audioausgabepuffer konnte nicht angelegt werden.") }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { channels[0].update(from: $0.baseAddress!, count: samples.count) }
        if scheduledFrames == 0 && player.isPlaying { player.pause(); underruns += 1 }
        scheduledFrames += samples.count
        timePitch.rate = PlaybackPolicy.rate(queuedSeconds: queuedSeconds)
        let current = generation
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.scheduledFrames = max(0, self.scheduledFrames - samples.count)
                self.playedFrames += samples.count
                self.timePitch.rate = PlaybackPolicy.rate(queuedSeconds: self.queuedSeconds)
            }
        }
        if !player.isPlaying {
            if queuedSeconds >= PlaybackPolicy.startupSeconds { beginPlayback() }
            else if startTask == nil {
                startTask = Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(60))
                    guard !Task.isCancelled, let self, self.generation == current else { return }
                    self.beginPlayback()
                }
            }
        }
    }

    private func beginPlayback() {
        startTask?.cancel(); startTask = nil
        if scheduledFrames > 0 { player.play() }
    }

    public func drain() async {
        beginPlayback()
        let deadline = ContinuousClock.now + .seconds(9)
        while scheduledFrames > 0 && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(30))
            if Task.isCancelled { return }
        }
    }

    public func stop() {
        generation = UUID()
        startTask?.cancel(); startTask = nil
        player.stop(); engine.stop(); engine.reset()
        scheduledFrames = 0; meter.reset(); timePitch.rate = 1
    }
}

private final class PlaybackMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var rms = 0.0
    private var lastActive = Date.distantPast
    var level: Double { lock.withLock { Date().timeIntervalSince(lastActive) < 0.22 ? rms : 0 } }
    func measure(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        var energy = 0.0
        for index in 0..<Int(buffer.frameLength) { energy += Double(channels[0][index] * channels[0][index]) }
        let value = sqrt(energy / Double(buffer.frameLength))
        lock.withLock { if value > 0.001 { rms = value; lastActive = Date() } }
    }
    func reset() { lock.withLock { rms = 0; lastActive = .distantPast } }
}
