import AVFoundation
import CoreAudio
import LiveTranslateCore

/// Control and teardown run on the main actor; all DSP runs on one serial queue.
@MainActor
public final class SystemAudioCapture {
    private var tap: AudioObjectID = 0
    private var aggregate: AudioObjectID = 0
    private var ioProc: AudioDeviceIOProcID?
    private let processor: CaptureProcessor
    private let queue = DispatchQueue(label: "live-translate.capture", qos: .userInteractive)
    private let controlQueue = DispatchQueue(label: "live-translate.audio-control", qos: .userInitiated)
    private var outputListener: AudioObjectPropertyListenerBlock?
    private var currentMix = SourceMix()
    private let onError: @Sendable (String) -> Void

    public init(onAudio: @escaping @Sendable (Data, Double) -> Void, onError: @escaping @Sendable (String) -> Void) {
        self.onError = onError
        processor = CaptureProcessor(onAudio: onAudio, onError: onError)
    }

    public func setMix(_ mix: SourceMix) {
        currentMix = mix
        queue.async { [processor] in processor.setMix(mix) }
    }

    public func prepare(bundleIdentifier: String?) async throws {
        do {
            queue.sync { processor.registerOutput() }
            let system = AudioObjectID(kAudioObjectSystemObject)
            let processes = try Self.objects(system, kAudioHardwarePropertyProcessObjectList)
            let ownPID = ProcessInfo.processInfo.processIdentifier
            let own = try processes.filter { try Self.pid($0) == ownPID }
            guard !own.isEmpty else { throw LiveError.audio("Die eigene Audioausgabe konnte nicht sicher ausgeschlossen werden.") }
            let description: CATapDescription
            if let bundleIdentifier {
                let matches = try processes.filter {
                    let bundle = try Self.string($0, kAudioProcessPropertyBundleID)
                    return bundle == bundleIdentifier || bundle.hasPrefix(bundleIdentifier + ".")
                }
                guard !matches.isEmpty else { throw LiveError.audio("Starte zuerst Ton in der gewählten App und versuche es erneut.") }
                description = CATapDescription(stereoMixdownOfProcesses: matches)
            } else {
                description = CATapDescription(stereoGlobalTapButExcludeProcesses: own)
            }
            description.name = "Live Translate Audio"
            description.isPrivate = true
            description.muteBehavior = .mutedWhenTapped
            try Self.check(AudioHardwareCreateProcessTap(description, &tap), "Systemaudio-Freigabe fehlt oder Audio-Tap konnte nicht erstellt werden")
            var format = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout.size(ofValue: format))
            var address = Self.address(kAudioTapPropertyFormat)
            try Self.check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format), "Audioformat lesen")
            guard let audioFormat = AVAudioFormat(streamDescription: &format), audioFormat.commonFormat == .pcmFormatFloat32 else {
                throw LiveError.audio("Dieses Ausgabegerät liefert kein unterstütztes Float-Audioformat.")
            }
            let configuration: [String: Any] = [
                kAudioAggregateDeviceNameKey: "Live Translate Audio",
                kAudioAggregateDeviceUIDKey: UUID().uuidString,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceTapAutoStartKey: true,
                kAudioAggregateDeviceTapListKey: [[
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true
                ]]
            ]
            try Self.check(AudioHardwareCreateAggregateDevice(configuration as CFDictionary, &aggregate), "Audio-Tap verbinden")
            try queue.sync { try processor.prepare(format: audioFormat, queue: queue); processor.mix = currentMix }
            try Self.check(AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) { [processor] _, input, _, _, _ in
                processor.receive(input)
            }, "Audioempfang vorbereiten")
            let listener: AudioObjectPropertyListenerBlock = { [onError] _, _ in
                onError("Das Audio-Ausgabegerät wurde gewechselt. Bitte die Übersetzung neu starten.")
            }
            var deviceAddress = Self.address(kAudioHardwarePropertyDefaultOutputDevice)
            try Self.check(AudioObjectAddPropertyListenerBlock(system, &deviceAddress, .main, listener), "Audioausgabe überwachen")
            outputListener = listener
        } catch {
            await stop()
            throw error
        }
    }

    public func start() async throws {
        guard aggregate != 0, let ioProc else { throw LiveError.audio("Audioaufnahme wurde nicht vorbereitet.") }
        try queue.sync { try processor.start() }
        let device = aggregate
        let status = await withCheckedContinuation { continuation in
            controlQueue.async { continuation.resume(returning: AudioDeviceStart(device, ioProc)) }
        }
        do { try Self.check(status, "Systemaudio starten; bitte Aufnahmefreigabe in macOS prüfen") }
        catch { await stop(); throw error }
    }

    public func stop() async {
        if let outputListener {
            var address = Self.address(kAudioHardwarePropertyDefaultOutputDevice)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, outputListener)
            self.outputListener = nil
        }
        let device = aggregate; let process = ioProc; let oldTap = tap
        aggregate = 0; ioProc = nil; tap = 0
        await withCheckedContinuation { continuation in
            controlQueue.async {
                if device != 0, let process {
                    AudioDeviceStop(device, process)
                    AudioDeviceDestroyIOProcID(device, process)
                }
                if device != 0 { AudioHardwareDestroyAggregateDevice(device) }
                if oldTap != 0 { AudioHardwareDestroyProcessTap(oldTap) }
                continuation.resume()
            }
        }
        queue.sync { processor.stop() }
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }
    private static func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw LiveError.audio("\(operation) (macOS \(status)).") }
    }
    private static func objects(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> [AudioObjectID] {
        var address = address(selector); var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size), "Audioprozesse lesen")
        var values = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        try values.withUnsafeMutableBytes { try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0.baseAddress!), "Audioprozesse lesen") }
        return values
    }
    private static func pid(_ object: AudioObjectID) throws -> pid_t {
        var address = address(kAudioProcessPropertyPID); var value: pid_t = 0
        var size = UInt32(MemoryLayout.size(ofValue: value))
        try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "Audioprozess lesen")
        return value
    }
    private static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var address = address(selector); var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout.size(ofValue: value))
        try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "Audio-App lesen")
        return value?.takeRetainedValue() as String? ?? ""
    }
}

private final class CaptureProcessor: @unchecked Sendable {
    var mix = SourceMix()
    func setMix(_ value: SourceMix) {
        let speaking = mix.sourceSpeaking
        mix = value; mix.sourceSpeaking = speaking
    }
    private var ramp = GainRamp()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var format: AVAudioFormat?
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(standardFormatWithSampleRate: Double(PCM.sampleRate), channels: 1)!
    private var queuedFrames = 0
    private var generation = UUID()
    private var queue: DispatchQueue?
    private var failed = false
    private var vad: NeuralVAD?
    private let onAudio: @Sendable (Data, Double) -> Void
    private let onError: @Sendable (String) -> Void

    init(onAudio: @escaping @Sendable (Data, Double) -> Void, onError: @escaping @Sendable (String) -> Void) {
        self.onAudio = onAudio; self.onError = onError
    }

    func registerOutput() {
        let engine = AVAudioEngine()
        _ = engine.outputNode.outputFormat(forBus: 0)
        self.engine = engine
    }

    func prepare(format: AVAudioFormat, queue: DispatchQueue) throws {
        self.format = format; self.queue = queue
        guard let converter = AVAudioConverter(from: format, to: target) else { throw LiveError.audio("Systemton konnte nicht konvertiert werden.") }
        self.converter = converter
        let engine = self.engine ?? AVAudioEngine(); let player = AVAudioPlayerNode()
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode,
            format: AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: format.channelCount))
        self.engine = engine; self.player = player
        vad = try NeuralVAD()
        failed = false; queuedFrames = 0; generation = UUID(); ramp = GainRamp()
    }

    func start() throws { engine?.prepare(); try engine?.start(); player?.play() }

    func receive(_ input: UnsafePointer<AudioBufferList>) {
        guard !failed, let format, let converter, let player, let queue else { return }
        let incoming = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = incoming.first, first.mData != nil, format.streamDescription.pointee.mBytesPerFrame > 0 else { return }
        let frames = first.mDataByteSize / format.streamDescription.pointee.mBytesPerFrame
        guard frames > 0 else { return }
        guard Double(queuedFrames + Int(frames)) / format.sampleRate < 0.3 else {
            fail("Die Originalausgabe hängt zurück. Der normale Systemton wird wieder freigegeben."); return
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buffer.frameLength = frames
        let destination = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard incoming.count == destination.count else { fail("Das Systemaudioformat wurde geändert. Bitte neu starten."); return }
        for index in incoming.indices {
            guard let source = incoming[index].mData, let dest = destination[index].mData,
                  incoming[index].mDataByteSize <= destination[index].mDataByteSize else { return }
            memcpy(dest, source, Int(incoming[index].mDataByteSize))
        }
        // Recognition and API input always receive the unattenuated source.
        guard let mono = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(ceil(Double(frames) * target.sampleRate / format.sampleRate)) + 64) else { return }
        var supplied = false; var error: NSError?
        converter.convert(to: mono, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        if let error { fail(error.localizedDescription); return }
        if let pointer = mono.floatChannelData?[0], mono.frameLength > 0 {
            let samples = Array(UnsafeBufferPointer(start: pointer, count: Int(mono.frameLength)))
            onAudio(PCM.encode(samples), PCM.rms(samples))
            do { mix.sourceSpeaking = try vad?.process(samples) ?? false }
            catch { fail("Neuronales Auto-Dubbing konnte nicht ausgeführt werden: \(error.localizedDescription)"); return }
        }
        guard let audible = sourceOutput(buffer, gain: mix.gain, ramp: &ramp) else {
            fail("Originalton konnte nicht für die Ausgabe gewandelt werden."); return
        }
        queuedFrames += Int(frames)
        let current = generation
        player.scheduleBuffer(audible, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            queue.async { [weak self] in
                guard let self, self.generation == current else { return }
                self.queuedFrames = max(0, self.queuedFrames - Int(frames))
            }
        }
    }

    private func fail(_ message: String) { guard !failed else { return }; failed = true; onError(message) }
    func stop() {
        generation = UUID(); player?.stop(); engine?.stop()
        engine = nil; player = nil; converter = nil; vad = nil; queuedFrames = 0
    }
}
