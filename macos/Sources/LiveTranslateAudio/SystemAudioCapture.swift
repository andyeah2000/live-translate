import AVFoundation
import CoreMedia
import ScreenCaptureKit
import LiveTranslateCore

public final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "live-translate.capture", qos: .userInteractive)
    private let onAudio: @Sendable (Data, Double) -> Void
    private let onError: @Sendable (String) -> Void

    public init(onAudio: @escaping @Sendable (Data, Double) -> Void, onError: @escaping @Sendable (String) -> Void) {
        self.onAudio = onAudio; self.onError = onError
    }

    @MainActor
    public func prepare(bundleIdentifier: String?) async throws {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        } catch {
            let failure = error as NSError
            if failure.domain == SCStreamErrorDomain, failure.code == SCStreamError.Code.userDeclined.rawValue {
                throw LiveError.audio("Bitte Live Translate in den macOS-Datenschutzeinstellungen für Bildschirm- und Systemaudioaufnahme freigeben.")
            }
            throw error
        }
        guard let display = content.displays.first else { throw LiveError.audio("Kein Bildschirm für die Audioaufnahme verfügbar.") }
        let filter: SCContentFilter
        if let bundleIdentifier {
            let apps = content.applications.filter { $0.bundleIdentifier == bundleIdentifier }
            guard !apps.isEmpty else { throw LiveError.audio("Die gewählte App läuft nicht mehr. Bitte erneut auswählen.") }
            filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        } else {
            let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
            filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
        }
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = PCM.sampleRate
        config.channelCount = 1
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false
        config.queueDepth = 3
        if #available(macOS 15, *) { config.captureMicrophone = false }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
    }

    @MainActor public func start() async throws {
        guard let stream else { throw LiveError.audio("Audioaufnahme wurde nicht vorbereitet.") }
        try await stream.startCapture()
    }

    @MainActor public func stop() async {
        let current = stream; stream = nil
        try? await current?.stopCapture()
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError("Die Systemaudio-Aufnahme wurde beendet: \(error.localizedDescription)")
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer),
              let description = sampleBuffer.formatDescription,
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return }
        guard format.mSampleRate == Double(PCM.sampleRate), format.mChannelsPerFrame == 1,
              format.mFormatID == kAudioFormatLinearPCM else {
            onError("macOS liefert ein unerwartetes Audioformat. Aufnahme gestoppt."); return
        }
        var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 0, mData: nil))
        var retained: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: &list,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard status == noErr, let pointer = list.mBuffers.mData else { return }
        let count = CMSampleBufferGetNumSamples(sampleBuffer)
        if format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32,
           Int(list.mBuffers.mDataByteSize) >= count * 4 {
            let samples = Array(UnsafeBufferPointer(start: pointer.assumingMemoryBound(to: Float.self), count: count))
            onAudio(PCM.encode(samples), PCM.rms(samples))
        } else if format.mBitsPerChannel == 16, Int(list.mBuffers.mDataByteSize) >= count * 2 {
            let data = Data(bytes: pointer, count: count * 2)
            onAudio(data, PCM.rms((try? PCM.decode(data)) ?? []))
        } else { onError("Das macOS-Audioformat kann nicht in PCM16 gewandelt werden.") }
        withExtendedLifetime(retained) {}
    }
}
