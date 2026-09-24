import Foundation
import Security
import LiveTranslateCore

public enum KeychainStore {
    private static let service = "org.andyeah.live-translate"
    private static let account = "openai-project-key"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public static func read() throws -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw LiveError.configuration("Schlüsselbund konnte nicht gelesen werden (\(status)).")
        }
        return String(data: data, encoding: .utf8)
    }

    public static func save(_ key: String) throws {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.contains("\n"), !key.contains("\r") else {
            throw LiveError.configuration("Der API-Key ist leer oder enthält Zeilenumbrüche.")
        }
        let data = Data(key.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let inserted = SecItemAdd(item as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw LiveError.configuration("API-Key konnte nicht gespeichert werden (\(inserted)).") }
        } else if status != errSecSuccess { throw LiveError.configuration("API-Key konnte nicht aktualisiert werden (\(status)).") }
    }
}
