import Foundation

public struct TranslationProfile: Decodable, Sendable {
    public let version: Int
    public let model: String
    public let defaultVoice: String
    public let voices: [String]
    public let instructions: String
    public let englishOnlyInstructions: String
    public let automaticInstructions: String
    public let delegationRecovery: String

    public static func bundled() throws -> Self {
        guard let url = Bundle.main.url(forResource: "translation-profile", withExtension: "json")
            ?? Bundle.module.url(forResource: "translation-profile", withExtension: "json") else {
            throw LiveError.configuration("Das Übersetzungsprofil fehlt im App-Bundle.")
        }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }

    public func prompt(englishOnly: Bool) -> String {
        instructions + "\n" + (englishOnly ? englishOnlyInstructions : automaticInstructions)
    }

    public func startEvent(voice: String, englishOnly: Bool) throws -> Data {
        guard voices.contains(voice) else { throw LiveError.configuration("Unbekannte Stimme.") }
        return try JSONSerialization.data(withJSONObject: [
            "type": "session.start", "event_id": UUID().uuidString,
            "session": [
                "model": model, "instructions": prompt(englishOnly: englishOnly),
                "store": false,
                "audio": ["format": ["type": "audio/pcm", "rate": PCM.sampleRate],
                          "output": ["voice": voice]],
                "delegation": ["type": "client"]
            ]
        ])
    }
}

public enum LiveError: Error, LocalizedError, Sendable {
    case configuration(String), transport(String), audio(String), timeout(String)
    public var errorDescription: String? {
        switch self {
        case .configuration(let text), .transport(let text), .audio(let text), .timeout(let text): text
        }
    }
}
