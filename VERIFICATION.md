# Verifikation

Diese Datei trennt nachgewiesene Eigenschaften von Modellqualität, die ohne
eine bilinguale menschliche Referenz nicht seriös garantiert werden kann.

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

- exakt 10 % Quellpegel während Sprache und exakt 100 % außerhalb – die
  Zielstimme läuft bewusst über den vollen Originalpegel weiter;
- getrennte Source-/Target-Untertitel bei Partial, Complete, Late Chunk,
  Interrupt, neuem Turn und der gemeinsamen Overlay-/Fullscreen-Darstellung;
- GPT-Live-Protokoll: Session-Antwort-Parser (`session.id` + `transport.sdp`),
  Event-Parser (`session.started`, `session.closed`, `error`,
  `session.input_transcript.delta`, `session.output_transcript.delta`),
  unveränderte Delta-Texte mit `start_ms`/`end_ms`, Endpoint-Builder und
  Ignorieren unbekannter Events;
- Server-Validierung: SDP-Pflicht und unveränderliches Handoff-JSON mit
  Deutsch/`marin`, Responses-Delegation und Websuche;
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

Coverage misst die importierten, testbaren Logikmodule einschließlich
`live-protocol.ts`, `subtitle-state.ts`, `audio-context-state.ts` und
`server/live-session.mjs`-Logik (über tsx-kompatible Pfade, wo importierbar).
Ausgenommen sind die Browser-/Geräteadapter `content.ts`, `popup.ts`,
`offscreen/main.ts`, `offscreen/live.ts` (WebRTC-Transport), die
AudioWorklet-Dateien, `vad-worker.ts` und der rein DOM-basierte
Popup-/Offscreen-Bootstrap; diese werden durch Build, statischen Audit und
die Chrome-Abnahme geprüft.

Der WebRTC-Transport (`live.ts`) besteht bewusst nur aus Verbindungsaufbau,
Remote-Track-Anbindung und Event-Weiterleitung – jede Entscheidung liegt in
den getesteten reinen Modulen. Abgenommen ist er erst mit dem Chrome-Lauf
gegen die echte API.

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
- Echter End-to-End-Lauf nur im Browser mit Mikrofon/Tab-Audio:
  `session.started` abwarten, sprechen, `session.output_transcript.delta`
  und Remote-Audio prüfen, mit `session.close` beenden und `session.closed`
  mit finaler Usage abwarten.
- Protokollnamen und Ablauf entsprechen der offiziellen OpenAI-Doku
  (WebRTC + Managing sessions, Stand 2026): `POST /v1/live/sessions` mit
  `session` + `transport: { type: "webrtc", sdp }`, Datenkanal `oai-events`,
  kein `session.start` nach HTTP-Start, kein `audio.format` bei WebRTC.

## Ehrliche Grenze

Transport, Clipping, Pegellogik und Lifecycle sind lokal deterministisch
prüfbar. Die semantische Übersetzungsgenauigkeit und die tatsächliche
Ende-zu-Ende-Latenz von GPT-Live benötigen wiederholte echte Läufe mit einer
manuell geprüften englisch–Zielsprache-Referenz. Eine Behauptung „jedes Wort
garantiert perfekt“ wäre ohne diese Ground Truth falsch. Die Abnahme im
laufenden Video mit gemessener Ende-zu-Ende-Latenz steht aus.
