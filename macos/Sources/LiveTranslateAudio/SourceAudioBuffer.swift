import AVFoundation
import LiveTranslateCore

/// AVAudioPlayerNode requires non-interleaved Float32; Core Audio taps may be interleaved.
func sourceOutput(_ input: AVAudioPCMBuffer, gain: Float, ramp: inout GainRamp) -> AVAudioPCMBuffer? {
    guard input.format.commonFormat == .pcmFormatFloat32,
          let format = AVAudioFormat(standardFormatWithSampleRate: input.format.sampleRate, channels: input.format.channelCount),
          let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: input.frameLength),
          let source = input.floatChannelData, let destination = output.floatChannelData else { return nil }
    output.frameLength = input.frameLength
    let channels = Int(format.channelCount)
    for frame in 0..<Int(input.frameLength) {
        let value = ramp.advance(toward: gain, sampleRate: format.sampleRate)
        for channel in 0..<channels {
            let sample = input.format.isInterleaved ? source[0][frame * channels + channel] : source[channel][frame]
            destination[channel][frame] = sample * value
        }
    }
    return output
}
