# Verifikation

Diese Datei trennt nachgewiesene Eigenschaften von Modellqualität, die ohne
eine bilinguale menschliche Referenz nicht seriös garantiert werden kann.

## Nachprüfung: 16. Oktober 2026 · Version 3.0.2

- Vertiefte Architekturprüfung mit drei getrennten Prüflinien und zusätzlicher
  unabhängiger Gegenprüfung der Aufnahme-/Lebenszyklusänderungen. Ergebnisse
  und verbleibende Grenzen stehen in `ARCHITECTURE_AUDIT.md`.
- Vollständiges `npm run check` mit Node **24.22.0** erfolgreich:
  TypeScript, ESLint, **174/174 Tests**, Coverage, MV3-Build und Audit mit
  **0 bekannten Schwachstellen**. Gegenüber 3.0.1 neun zusätzliche Testfälle.
- Coverage: **96,47 % Lines / 86,04 % Branches / 86,81 % Functions**;
  die Coverage-Ausführung enthält 155 TypeScript-Tests. Die Mindestwerte
  **90/75/80** bleiben unverändert.
- Wegen stockender FileProvider-Zugriffe wurde der abschließende Lauf aus
  einer lokalen Kopie außerhalb des synchronisierten Projektordners ausgeführt.
  Die 105 kopierten Quelldateien wurden anschließend vor der Buildübernahme
  per SHA-256 gegen das Arbeitsverzeichnis geprüft. Alle waren identisch.
- Der geprüfte Build liegt in `dist/`, als ZIP in
  `artifacts/live-translate-3.0.2-chrome.zip` und als bytegeprüfte Desktop-Kopie
  `~/Desktop/LiveTranslateChrome`. Keine Zugangsdaten sind Teil des Builds.
- Lokaler Server mit gespeicherter Konfiguration auf `127.0.0.1:8787`:
  fehlender Token **401**, falscher Token **401**, fremde Origin **403**,
  ungültiges SDP **400**. Diese vier Probes erzeugen keine Providersitzung.

### Echte Provider- und Chrome-Prüfungen

Der native Probe-Client hat mit `gpt-live-1` und Stimme `meridian` tatsächlich
Audio übertragen und deutsche Audioausgabe empfangen. Der synthetische
englische Clip dauert **16,38 Sekunden**. Zahlen, Verneinung und die Form einer
Frage blieben in der deutschen Übersetzung erhalten. Gemessen wurden
**1,87 Sekunden** Verbindungsaufbau und **3,02 Sekunden** bis zur ersten nicht
stillen Ausgabe nach dem ersten nicht stillen Eingang. **44 Quell- und 49
Zieltranskript-Deltas**, bestätigtes `session.closed`, 26 Nutzungssekunden.
Die Paketzeit ist keine Messung semantischer Übersetzungsverzögerung. Eine
menschliche Hörbewertung wurde damit nicht ersetzt.

Im tatsächlich geladenen **Chrome-Build 3.0.1** wurden auf einem YouTube-Video
deutsche Untertitel und der Status **„Deutsche Sprachausgabe · Audiopegel
gemessen“** beobachtet. Ziel-Lautstärke **0 %** stellte den angezeigten
Originalpegel auf **100 %**; Zurückstellen auf **100 %** aktivierte die Ausgabe
wieder. Der Stop-Knopf führte sichtbar zu **„Gestoppt“** ohne angezeigten
Finalisierungsfehler. Das offizielle Tesla-Video „Roadster Event“ wurde
zusätzlich geöffnet und bei 0:00 pausiert bereitgelegt.

Der aktualisierte Build **3.0.2** benötigt nach dem Austausch der Desktop-Dateien
ein manuelles Neuladen der Erweiterung. Seine vollständige Live-Abnahme wird
erst nach diesem Neuladen bestätigt. Die Browsersteuerung verweigert den
automatischen Zugriff auf `chrome://extensions`; die Sperre wurde nicht
umgangen. Längere Sitzungen, wechselnde Netzbedingungen, vollständige
Vollbild-Abnahme und bilinguale Hörbewertung bleiben offen.

## Prüfstand: 16. Oktober 2026 · Version 3.0.1

Geprüfte Ausgangsbasis: `f7d1a896230df5a0ce022198cefcf0e768814db6`.
Dieser Durchlauf behebt belegte Fehler in Chrome, Backend und nativem
Sitzungsstart. Er ist keine Zusicherung, dass unbekannte Fehler ausgeschlossen sind.

- Vollständiges `npm run check` mit Node **24.22.0**, entsprechend der
  CI-Hauptversion: TypeScript, ESLint, **165/165 Tests**, Coverage, MV3-Build und
  Dependency-Audit erfolgreich. **0 bekannte Schwachstellen**.
- TypeScript-Coverage: **96,88 % Lines / 85,50 % Branches / 85,51 % Functions**.
  Alle ursprünglichen Mindestwerte **90/75/80** bleiben bestehen. Popup,
  Content Script, direkte Media-Aufnahme und Offscreen-Bootstrap werden jetzt
  zusätzlich getestet. Die Coverage-Ausführung enthält 146 TypeScript-Tests;
  die Gesamtzahl 165 umfasst auch die separaten JavaScript-Tests.
- **22/22 Swift-Tests** bestanden, einschließlich drei neuer Regressionen für
  unmittelbar aufeinanderfolgende Start-, Fehler- und Abschlussereignisse.
  Lokaler Befehl: `swift test --package-path macos --scratch-path /tmp/live-translate-swift-20261016`.
  Der separate Buildpfad umgeht FileProvider-Metadaten im Documents-Ordner,
  die beim ersten Versuch die lokale Codesign-Prüfung des Ressourcenbundles
  blockierten. Ein neues signiertes macOS-Releasepaket wurde nicht erstellt.
- Popup des gebündelten Builds in Chrome mit lokal simulierten Chrome-APIs
  geprüft: initiale Anzeige, Start, Stop, sichtbare Statusmeldungen und
  Ablehnung einer unzulässigen HTTP-Serveradresse. Das ist eine UI-Prüfung,
  kein Nachweis einer echten Tab-Aufnahme oder Provider-Übersetzung.
- Zehn Backend-Tests verwenden echte lokale HTTP-Verbindungen mit einem
  simulierten OpenAI-Upstream. Abdeckung: Authentifizierung/Origin, Requestlimit,
  Antwortvalidierung, Header-/Body-Timeout, Browserabbruch und Fehlerantworten.
- Unabhängige Gegenprüfungen von Backend, Chrome-Lifecycle und UI durchgeführt;
  die dabei gefundene verwaiste lokale Verbindung bei Offer-Timeout wurde
  ebenfalls behoben und durch Regressionstests abgesichert.

### Behobene Fehlergruppen

- Start/Stopp: begrenzte Message-Antwortzeiten, unmittelbares Aufräumen auch
  während eines Starts, keine doppelten WebRTC-Verbindungen, keine falsche
  Start- oder Finalisierungsbestätigung nach Abbruch.
- Audio: Originalton schon während lokaler Verbindungsverhandlung,
  geprüfter direkter Eingang vor Providerstart, gespeicherte Stummschaltung
  während des Starts, sichtbares Ende nach Verlust der Audio-Engine oder
  Quellspur; verspätete Ereignisse verändern keine Ersatzsitzung.
- WebRTC: Erholung bei kurzer Netzunterbrechung, begrenzter Disconnect-Zustand,
  eindeutige Zielspur und Schutz vor Fehlern eines ersetzten Playback-Versuchs.
- Popup/Einstellungen: sichtbare Statusmeldungen, Schutz vor veralteten
  Zustandsantworten, einheitliche URL-/Tokenprüfung, geordnete Speicherung,
  sichtbare Fehler bei Ausgabeänderungen.
- Untertitel: keine leeren nativen Fullscreen-Tracks, Wiederverwendung und
  Deaktivierung vorhandener Tracks, Zeitachsen-Reset nach Unterbrechung.
- Backend: Abbruchweitergabe, vollständige Antwortprüfung, begrenzte Bodygröße,
  lesbarer HTTP-413-Fehler statt Socket-Abbruch, keine ungeprüfte Weiterleitung
  zusätzlicher Upstream-Felder.
- Native App: Providerfehler können nicht durch spätere Bereitschafts- oder
  Abschlussereignisse verdeckt werden.
- Abhängigkeiten: `brace-expansion` im Lockfile von 5.0.9 auf 5.0.12 aktualisiert.

### Modell und verbleibende Live-Abnahme

`gpt-live-1`, WebRTC und die serverseitigen Dolmetscheranweisungen bleiben
beibehalten. Der Session-Vertrag wurde am 16. Oktober 2026 mit der
[offiziellen Create-Session-Dokumentation](https://developers.openai.com/api/reference/resources/live/methods/create)
abgeglichen.

Zum Zeitpunkt dieses ersten Prüflaufs waren weder `.env.local`/`OPENAI_API_KEY`
noch der früher dokumentierte LaunchAgent im frischen Checkout vorhanden.
Dieser erste Lauf enthielt keine kostenpflichtigen Live-Anfragen. Die später
ausgeführten Provider- und Chrome-Prüfungen stehen im Abschnitt zur Nachprüfung
oben; deren genaue Grenzen bleiben maßgeblich.
Die folgenden älteren Ergebnisse sind historische Evidenz und wurden nur dort
erneut geprüft, wo der aktuelle Abschnitt dies ausdrücklich ausweist.

## Historischer Prüfstand: 24. September 2026

- `npm run check`: erfolgreich; Typecheck, ESLint, 105 Tests einschließlich
  Server-Tests, Coverage, MV3-Build und Audit mit null bekannten Schwachstellen.
- Coverage der TypeScript-Tests: 94,42 % Lines, 81,32 % Branches,
  81,03 % Functions. Die Mindestwerte 90/75/80 wurden nicht abgesenkt.
- `swift test --package-path macos`: 19 Tests erfolgreich; PCM16,
  Puffergrenzen, Delta-Texte, echtes Sitzungsprotokoll mit simuliertem Transport,
  Abbrüche, fehlendes Guthaben und bestätigte finale Nutzungswerte.
- Native Ausgabeprüfung: 12.000 Testton-Samples durch AVAudioEngine abgespielt.
- Release-App mit Swift 6.4 auf macOS 27 gebaut; lokale Signaturprüfung erfolgreich.
- Native Mix-Regressionen prüfen Sprach-/Atmosphäre-Absenkung, Stummschaltung,
  Pegelrampen, Silero-Hysterese und Stereo-Deinterleaving ohne Veränderung des
  API-Eingangs. Das echte gebündelte ONNX-Modell läuft im Test auf Stille.
- Lokaler Silero-Test mit dem vorhandenen synthetischen Sprachclip: 290
  Inferenzen, 462 erkannte 20-ms-Sprachblöcke, maximale Wahrscheinlichkeit
  0,99999964; etwa 38 ms gesamte Inferenz-/Konvertierungszeit. Das ist keine
  Messung der Ende-zu-Ende-Latenz oder der Erkennungsqualität natürlicher Videos.
- Der frühere TCC-Signaturfehler ist im macOS-Protokoll nachgewiesen. Das
  Buildskript verwendet nun eine beständige Apple-Zertifikatssignatur statt
  einer bei jedem Build wechselnden Ad-hoc-Identität.
- Der neue native Mix verwendet einen Core-Audio-Tap mit reiner Audiofreigabe.
  Der echte lokale Audiotest erreicht die macOS-Freigabeaufforderung. Deren
  Bestätigung und die hörbare Abnahme des vollständigen Mixes stehen noch aus.
- Der Projektschlüssel liegt im Schlüsselbund. Der letzte echte GPT-Live-Test
  wurde wegen fehlenden API-Guthabens abgelehnt. Es liegt deshalb noch keine
  vollständige Live-Abnahme vor.
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
  echte Core-Audio-Tap-Eingabe, Ausschluss der eigenen Ausgabe und hörbare
  deutsche Übersetzung bestätigen; ein Probe-Erfolg allein reicht dafür nicht.

## Ehrliche Grenze

Transport, Clipping, Pegellogik und Lifecycle sind lokal deterministisch
prüfbar. Die semantische Übersetzungsgenauigkeit und die tatsächliche
Ende-zu-Ende-Latenz von GPT-Live benötigen wiederholte echte Läufe mit einer
manuell geprüften englisch–Zielsprache-Referenz. Eine Behauptung „jedes Wort
garantiert perfekt“ wäre ohne diese Ground Truth falsch. Die Abnahme im
laufenden Video mit gemessener Ende-zu-Ende-Latenz steht aus.
