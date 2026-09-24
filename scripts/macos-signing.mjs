export function selectSigningIdentity(output, explicitIdentity) {
  if (explicitIdentity?.trim()) return explicitIdentity.trim();
  const identities = [...output.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/gm)]
    .map(([, hash, name]) => ({ hash, name }));
  for (const prefix of ['Developer ID Application:', 'Apple Development:']) {
    const candidates = identities.filter(({ name }) => name.startsWith(prefix));
    if (candidates.length === 1) return candidates[0].hash;
    if (candidates.length > 1) {
      throw new Error('Mehrere Signaturzertifikate vorhanden. LIVE_TRANSLATE_SIGN_IDENTITY ausdrücklich setzen.');
    }
  }
  throw new Error('Kein Apple-Entwicklerzertifikat gefunden. In Xcode ein Apple Development-Zertifikat einrichten. Für einen reinen CI-Build ohne dauerhafte Audiofreigabe LIVE_TRANSLATE_SIGN_IDENTITY=- setzen.');
}
