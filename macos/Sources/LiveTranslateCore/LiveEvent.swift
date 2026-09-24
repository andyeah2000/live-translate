import Foundation

public enum LiveEvent: Sendable {
    case started
    case audio(Data)
    case transcript(lane: TranscriptLane, text: String, start: Double?, end: Double?)
    case usage(Double)
    case closed(seconds: Double?, reason: String)
    case delegation(String)
    case error(String)
    case ignored

    public static func parse(_ data: Data) throws -> Self {
        guard data.count <= 2_097_152,
              let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String else { return .ignored }
        switch type {
        case "session.started": return .started
        case "session.output_audio.delta":
            guard let delta = event["delta"] as? String, let audio = Data(base64Encoded: delta),
                  !audio.isEmpty, audio.count.isMultiple(of: 2) else {
                throw LiveError.audio("GPT-Live lieferte ein ungültiges Audiopaket.")
            }
            return .audio(audio)
        case "session.input_transcript.delta", "session.output_transcript.delta":
            guard let delta = event["delta"] as? String, !delta.isEmpty else { return .ignored }
            return .transcript(lane: type.contains("input_") ? .source : .target, text: delta,
                               start: nonnegative(event["start_ms"]), end: nonnegative(event["end_ms"]))
        case "session.usage.updated":
            guard let usage = event["usage"] as? [String: Any], let seconds = nonnegative(usage["seconds"]) else { return .ignored }
            return .usage(seconds)
        case "session.closed":
            let usage = event["usage"] as? [String: Any]
            return .closed(seconds: nonnegative(usage?["seconds"]), reason: event["reason"] as? String ?? "unknown")
        case "session.delegation.created":
            guard let delegation = event["delegation"] as? [String: Any], let id = delegation["id"] as? String, !id.isEmpty else { return .ignored }
            return .delegation(id)
        case "error":
            let error = event["error"] as? [String: Any]
            let message = error?["message"] as? String ?? "GPT-Live hat die Sitzung abgelehnt."
            if message.lowercased().contains("no credits") || (error?["code"] as? String) == "insufficient_quota" {
                return .error("Das OpenAI-API-Guthaben ist aufgebraucht. Bitte das API-Projekt aufladen oder einen anderen Projektschlüssel verwenden.")
            }
            return .error(message)
        default: return .ignored
        }
    }

    private static func nonnegative(_ value: Any?) -> Double? {
        guard let value = value as? Double, value.isFinite, value >= 0 else { return nil }
        return value
    }
}

public enum TranscriptLane: String, Codable, Sendable { case source, target }

public struct Caption: Identifiable, Codable, Sendable {
    public let id: UUID
    public let lane: TranscriptLane
    public var text: String
    public let start: Double?
    public var end: Double?
}

public struct CaptionTimeline: Sendable {
    public private(set) var captions: [Caption] = []
    public init() {}

    public mutating func append(lane: TranscriptLane, text: String, start: Double?, end: Double?) {
        guard !text.isEmpty else { return }
        if let index = captions.lastIndex(where: { $0.lane == lane }),
           captions[index].text.count < 240,
           start == nil || captions[index].end == nil || (start! - captions[index].end! < 700 && start! >= (captions[index].start ?? 0)) {
            captions[index].text += text
            captions[index].end = end ?? captions[index].end
        } else {
            captions.append(Caption(id: UUID(), lane: lane, text: text, start: start, end: end))
        }
        if captions.count > 200 { captions.removeFirst(captions.count - 200) }
    }

    public func latest(_ lane: TranscriptLane) -> String { captions.last(where: { $0.lane == lane })?.text ?? "" }
}
