import Foundation

public enum PCM {
    public static let sampleRate = 24_000
    public static let bytesPerSecond = sampleRate * 2
    public static let frameSamples = sampleRate / 50
    public static let frameBytes = frameSamples * 2
    public static let silence = Data(count: frameBytes)

    public static func encode(_ samples: [Float]) -> Data {
        var bytes = Data(capacity: samples.count * 2)
        for sample in samples {
            let finite = sample.isFinite ? sample : 0
            let value = Int16(max(-32_768, min(32_767, (Double(finite) * 32_768).rounded())))
            let bits = UInt16(bitPattern: value)
            bytes.append(UInt8(truncatingIfNeeded: bits))
            bytes.append(UInt8(truncatingIfNeeded: bits >> 8))
        }
        return bytes
    }

    public static func decode(_ data: Data) throws -> [Float] {
        guard data.count.isMultiple(of: 2) else { throw LiveError.audio("Unvollständiges PCM16-Sample.") }
        let bytes = [UInt8](data)
        return stride(from: 0, to: bytes.count, by: 2).map {
            Float(Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8)) / 32_768
        }
    }

    public static func rms(_ samples: [Float]) -> Double {
        guard !samples.isEmpty else { return 0 }
        return sqrt(samples.reduce(0.0) { $0 + Double($1.isFinite ? $1 * $1 : 0) } / Double(samples.count))
    }
}

/// Refuse overload instead of silently dropping words or accumulating unlimited latency.
public struct PCMQueue: Sendable {
    private var storage = Data()
    private var offset = 0
    public let capacity: Int
    public var byteCount: Int { storage.count - offset }
    public var milliseconds: Double { Double(byteCount) / Double(PCM.bytesPerSecond) * 1_000 }

    public init(maxMilliseconds: Int = 500) {
        capacity = PCM.bytesPerSecond * maxMilliseconds / 1_000
    }

    public mutating func append(_ data: Data) throws {
        guard data.count.isMultiple(of: 2) else { throw LiveError.audio("Ungültige PCM-Paketlänge.") }
        guard byteCount + data.count <= capacity else {
            throw LiveError.audio("Der Audiopuffer ist voll. Die Verbindung kann nicht in Echtzeit folgen.")
        }
        if offset > 0 { storage = Data(storage.dropFirst(offset)); offset = 0 }
        storage.append(data)
    }

    public mutating func readFrame(padSilence: Bool = true) -> Data? {
        if !padSilence && byteCount < PCM.frameBytes { return nil }
        let length = min(byteCount, PCM.frameBytes)
        var result = Data(storage[offset..<(offset + length)])
        offset += length
        if padSilence && length < PCM.frameBytes { result.append(Data(count: PCM.frameBytes - length)) }
        if offset == storage.count { storage.removeAll(keepingCapacity: true); offset = 0 }
        return result
    }

    public mutating func removeAll() { storage.removeAll(keepingCapacity: true); offset = 0 }
}

public enum PlaybackPolicy {
    public static let startupSeconds = 0.06
    public static let maximumSeconds = 8.0
    public static func rate(queuedSeconds: Double) -> Float {
        Float(min(1.12, max(1.0, 1.0 + (queuedSeconds - 0.35) * 0.06)))
    }
}
