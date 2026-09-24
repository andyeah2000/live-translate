# Verifikation

Diese Datei trennt nachgewiesene Eigenschaften von Modellqualität, die ohne
eine bilinguale menschliche Referenz nicht seriös garantiert werden kann.

## Aktueller Prüfstand: 24. September 2026

- `npm run check`: erfolgreich; Typecheck, ESLint, 100 Tests einschließlich
  Server-Tests, Coverage, MV3-Build und Audit mit null bekannten Schwachstellen.
- Coverage der TypeScript-Tests: 94,42 % Lines, 81,32 % Branches,
  81,03 % Functions. Die Mindestwerte 90/75/80 wurden nicht abgesenkt.
- `swift test --package-path macos`: 13 Tests erfolgreich; PCM16,
  Puffergrenzen, Delta-Texte, echtes Sitzungsprotokoll mit simuliertem Transport,
  Abbrüche, fehlendes Guthaben und bestätigte finale Nutzungswerte.
- Native Ausgabeprüfung: 12.000 Testton-Samples durch AVAudioEngine abgespielt.
- Release-App mit Swift 6.4 auf macOS 27 gebaut; lokale Signaturprüfung erfolgreich.
- Der neue Projektschlüssel wurde über das native Pop-up im Schlüsselbund
  gespeichert. Auch der erneute echte GPT-Live-Test damit wurde wegen fehlenden
  API-Guthabens abgelehnt. Der lokale Systemaudio-Test wurde durch macOS TCC
  abgelehnt. Es liegt deshalb noch keine vollständige Live-Abnahme vor.
- Das kompakte Pop-up mit nativen Bedienelementen, Einstellungen und
  Schlüssel-Speicherung wurde in der installierten Menüleisten-App geprüft.

Die weiter unten dokumentierten Vollvideo- und Chrome-Messungen stammen aus
früheren Projektständen und wurden bei dieser macOS-Erweiterung nicht erneut
durchgeführt. Insbesondere sind sie kein Qualitätsnachweis für die native App.

## Automatisierte Abnahme

```bash
npm ci
npm run check
```

`npm run check` umfasst striktes TypeScript inklusive unbenutzter Symbole,
TypeScript-ESLint, alle Unit-/Integrationsprüfungen mit mindestens 90 % Lines,
75 % Branches und 80 % Functions, den vollständigen MV3-Build und
`npm audit --audit-level=moderate`. GitHub
Actions führt denselben Befehl bei Pushes und Pull Requests mit Node.js 24 aus.

Die Tests decken unter anderem ab:

- ausgabegesteuerten Quellmix mit 100 % außerhalb der deutschen Ausgabe,
  28 % bei gleichzeitiger Quellsprache und 60 % bei Atmosphäre;
- getrennte Source-/Target-Untertitel bei Partial, Complete, Late Chunk,
  Interrupt, neuem Turn und der gemeinsamen Overlay-/Fullscreen-Darstellung;
- GPT-Live-Protokoll: Session-Antwort-Parser (`session.id` + `transport.sdp`),
  Event-Parser (`session.started`, `session.closed`, `error`,
  `session.input_transcript.delta`, `session.output_transcript.delta`),
  unveränderte Delta-Texte mit `start_ms`/`end_ms`, Endpoint-Builder und
  Ignorieren unbekannter Events;
- Server-Validierung: SDP-Pflicht, gemeinsames Übersetzungsprofil, Standardstimme
  `meridian`, Client-Delegation ohne Responses-Backend oder Websuche;
- Begrenzung und Verwerfung von Server-URL, Token, Stimme und Ausgabeoptionen;
  wirkungslose Sprach-, Keyterm- und Echo-Einstellungen werden entfernt;
- das Entfernen der abgelösten Provider-Keys (`grokKey`, `geminiKey`,
  `deeplKey`, …) aus `chrome.storage.local`;
- Weiterleitung der Quell-Transkriptspur ausschließlich im Dual-Modus;
- AudioContext-Wiederaufnahme mit harter Zeitgrenze und verifiziertem
  `running`-Endzustand statt endloser Resume-Schleife;
- Verwerfen privilegierter Runtime-Nachrichten von Webseiten-Absendern;
- idempotenten one-shot Tab-Capture-Start;
- geordneten Stop, Session-Races und stale Output-Updates;
- `session.close`-Finalisierung: Audio/Transport bleiben bis `session.closed`
  erhalten; Timeout oder Disconnect werden ausdrücklich als unvollständig
  gemeldet;
- den Chrome-116-Offscreen-Fallback über `runtime.getContexts`;
- harte `tabCapture`-Abbrüche mit Tab-/Session-Recheck;
- Untertitel-Reparenting Body → Fullscreen-Container → Body;
- lokale Silero-Modellintegrität und MV3-CSP.

Coverage misst die durch die TypeScript-Tests importierten Module, jetzt auch
`offscreen/live.ts`. Die zusätzlichen Transporttests simulieren WebRTC-Peer,
Datenkanal und Audioelement. Sie prüfen den einzigen hörbaren Audioausgang,
Fallback, Autoplayfehler, Delegation, Verbindungsfehler und Close-Timeouts.
Server-Tests laufen zusätzlich in `npm test`; deren Abdeckung wird nicht in
der TypeScript-Coverage behauptet. Nicht importierte Browser-Bootstraps und
Audiotreiber benötigen weiter eine echte Browser-/Geräteprüfung.

## Vollvideo-Audit: SpaceX Critical Path

Referenz: [SpaceX – Critical Path](https://www.spacex.com/content/starship/critical-path)

| Eigenschaft | Wert |
|---|---:|
| Audiolänge | 2.055,552 s |
| Format des Audits | 48 kHz, Stereo |
| SHA-256 der geprüften M4A-Datei | `d40134f584621ad2c4b2d0bbd4768b1ddddc850131fdd74df1837d26c03e6998` |
| Silero-Frames | 64.235 je Encoding |
| als Sprache aktive Zeit | 56,046–56,135 % |
| vollständig abgedeckte Wortkerne | 92,993–93,486 % |
| Wortkerne mit irgendeiner VAD-Abdeckung | 97,950–98,157 % |
| Safe-negative False-Duck-Proxy | 5,430–5,442 % |
| Pegelwechsel | 13,019–13,311/min |

Die Bereiche stammen aus zwei AAC-Encodings derselben offiziellen HLS-Spur.
Geprüft wurden 3.853 hochkonfidente Wortkerne aus einer bereinigten
Whisper-Large-v3-Turbo-Zeitreferenz. Whisper ist dabei keine menschliche
Ground Truth. Fehlende VAD-Treffer bedeuten keinen Übersetzungsverlust:
Silero steuert nur den Original-Gain; der WebRTC-Uplink läuft unabhängig.

## PCM-Sättigung

Ein echter Chrome-`OfflineAudioContext`-Render des vollständigen Films bewies,
dass `DynamicsCompressorNode` kein Brickwall-Limiter ist.

| Modelleingang | Peak nach 16 kHz | saturierte Samples | Sprachkern-RMS |
|---|---:|---:|---:|
| früher, Makeup 6,8 | 1,442328 | 77.865 / 0,236752 % | −9,912 dBFS |
| Makeup 4,0 | 1,247468 | 4.708 / 0,014315 % | −11,686 dBFS |
| aktuell, Makeup 6,8 + Soft-Knee | 0,979714 | **0** | −9,957 dBFS |

## Ausgangsmix

Der frühere Master-`DynamicsCompressorNode` wurde entfernt, weil Chromes
automatisches Makeup selbst den Solo-Originalton um 0,57 dB veränderte. Der
aktuelle 4×-Soft-Knee-Waveshaper wurde in echtem Chrome gemessen:

- gleichphasiger synthetischer Worst-Case-Mix: Peak 0,945269, null Clips;
- Solo-SpaceX: Peak vor/nach dem Begrenzer 0,558639;
- ausgerichtete Differenz: −117,416 dB relativ;
- konstante Gruppenlaufzeit: 192 Samples beziehungsweise 4 ms.

## Browserprüfung

Der Content-Build wurde in echtem Chrome in ein natives `<video>`-Vollbild
geladen. Verifiziert wurden `document.fullscreenElement === VIDEO`, ein
programmatischer Subtitle-`TextTrack` im Modus `showing` und der erwartete
laufende `VTTCue`. Damit bleiben Untertitel auch im nativen Vollbild des
SpaceX-Players verfügbar.

## GPT-Live-Abnahme (manuell)

- `tests/probe-auth.mjs` prüft ohne Kontingent: Origin-Check, Token-Check,
  Validierung (Erwartung 401/401/403/400).
- Der frühere Smoke-Test wurde entfernt: HTTP 502 belegt keinen gültigen
  OpenAI-Key und ersetzt keine erfolgreiche WebRTC-Sitzung.
- Echter End-to-End-Lauf im Browser mit Tab-Audio:
  `session.started` abwarten, sprechen, `session.output_transcript.delta`
  und Remote-Audio prüfen, mit `session.close` beenden und `session.closed`
  mit finaler Usage abwarten.
- Protokollnamen und Ablauf entsprechen der offiziellen OpenAI-Doku
  (WebRTC + Managing sessions, Stand 2026): `POST /v1/live/sessions` mit
  `session` + `transport: { type: "webrtc", sdp }`, Datenkanal `oai-events`,
  kein `session.start` nach HTTP-Start, kein `audio.format` bei WebRTC.
- Der native `LiveTranslateProbe --live-test` prüft denselben Dienst über
  WebSocket mit einer freigegebenen Sprachdatei. Der App-Test muss zusätzlich
  echte ScreenCaptureKit-Eingabe, Ausschluss der eigenen Ausgabe und hörbare
  deutsche Übersetzung bestätigen; ein Probe-Erfolg allein reicht dafür nicht.

## Ehrliche Grenze

Transport, Clipping, Pegellogik und Lifecycle sind lokal deterministisch
prüfbar. Die semantische Übersetzungsgenauigkeit und die tatsächliche
Ende-zu-Ende-Latenz von GPT-Live benötigen wiederholte echte Läufe mit einer
manuell geprüften englisch–Zielsprache-Referenz. Eine Behauptung „jedes Wort
garantiert perfekt“ wäre ohne diese Ground Truth falsch. Die Abnahme im
laufenden Video mit gemessener Ende-zu-Ende-Latenz steht aus.
