import Foundation

public struct SourceMix: Sendable {
    public var volume: Double = 1
    public var muted = false
    public var ducking = true
    public var duckLevel: Double = 0.28
    public var sourceSpeaking = false
    public var translationAudible = false

    public init() {}

    public var gain: Float {
        if muted { return 0 }
        let base = volume.isFinite ? min(1, max(0, volume)) : 1
        let duck = duckLevel.isFinite ? min(1, max(0, duckLevel)) : 0.28
        return Float(base * (ducking && translationAudible ? (sourceSpeaking ? duck : max(duck, 0.6)) : 1))
    }
}

public struct GainRamp: Sendable {
    public private(set) var value: Float = 1
    public init() {}

    public mutating func advance(toward target: Float, sampleRate: Double) -> Float {
        let seconds = target < value ? 0.03 : 0.18
        let step = Float(1 / (max(1, sampleRate) * seconds))
        value += min(step, max(-step, target - value))
        return value
    }
}

/// Same Silero hysteresis as the Chrome addon, at one decision per 32 ms.
public struct SpeechDecision: Sendable {
    public private(set) var speaking = false
    private var window: [Bool] = []
    private var releaseScore = 0
    public init() {}

    public mutating func update(_ value: Double) {
        let probability = value.isFinite ? min(1, max(0, value)) : 0
        if !speaking {
            window.append(probability >= 0.56)
            if window.count > 3 { window.removeFirst() }
            if probability >= 0.74 || window.filter({ $0 }).count >= 2 {
                speaking = true; releaseScore = 0; window.removeAll()
            }
        } else if probability >= 0.56 {
            releaseScore = 0
        } else {
            releaseScore += probability < 0.48 ? 2 : 1
            if releaseScore >= 23 { self = SpeechDecision() }
        }
    }
}
