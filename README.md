# Live Translate

Gesprochene Live-Übersetzung ins Deutsche mit **OpenAI GPT-Live
(`gpt-live-1`)**. Als kleine native macOS-Menüleisten-App für Systemton oder
eine einzelne App, zusätzlich als Chrome-Erweiterung für einen Tab.

Die macOS-App verbindet sich direkt per WebSocket mit OpenAI. Die Erweiterung
nutzt WebRTC und ein eigenes lokales Backend. Beide verwenden denselben
Übersetzungsprompt und dieselbe Stimmenliste. Standardstimme ist `meridian`.

## macOS-Menüleisten-App

Voraussetzungen: macOS 14.4+, Xcode mit Swift 6 und Apple-Signaturzertifikat, Node.js für das Buildskript,
ein OpenAI-Projektschlüssel mit GPT-Live-Zugriff und API-Guthaben.

```bash
npm run macos:test
npm run macos:build
```

Die App liegt unter `macos/build/Live Translate.app` und lässt sich in den
Programme-Ordner kopieren. Sie öffnet ein kleines Pop-up am Symbol in der
Menüleiste und besitzt kein Dock-Symbol und kein Hauptfenster. Einstellungen,
Audioquelle, Stimme, Lautstärke, Untertitel und Start/Stopp liegen im Pop-up.

Der Schlüssel wird über die Einstellungen in den macOS-Schlüsselbund
gespeichert. macOS muss die Aufnahme von Systemaudio erlauben. Es werden
keine Bildschirmbilder oder Mikrofonsignale an OpenAI geschickt. Der eigene
Ausgabeton ist von der Aufnahme ausgeschlossen; virtuelle Audiotreiber sind
nicht erforderlich. Originalton und deutsche Stimme haben getrennte Regler und
Stummschalter. Neuronales Auto-Dubbing mit lokalem Silero VAD ist standardmäßig
aktiv: Während hörbarer Übersetzung wird Quellsprache auf 28 %, Atmosphäre auf
60 % abgesenkt. Der Originalregler wirkt zusätzlich; beim Stoppen endet der Mix.
Die automatische Absenkung lässt sich in den Einstellungen ändern oder abschalten.

[Einrichtung und Bedienung](docs/MACOS.md) ·
[API- und Forschungsentscheidungen](docs/RESEARCH.md) ·
[Prüfstand und Grenzen](VERIFICATION.md)

## Pipeline

Ein WebRTC-Track trägt Tab-Audio direkt in die Live-Sitzung, ein zweiter
Track trägt die übersetzte Zielstimme zurück. Der Datenkanal liefert nur
Status und Transkripte:

```text
Tab-Audio (MediaStreamTrack)
  │  WebRTC Offer (Browser) → POST /api/live/session (eigener Server)
  │                           → POST https://api.openai.com/v1/live/sessions
  ▼
GPT-Live (gpt-live-1, Client-Delegation, Anweisungen = Dolmetscher)
  │
  ├─ Audio: Zielstimme als WebRTC-Remote-Track → translatedGain
  └─ Datenkanal oai-events:
       session.started → bereit
       session.input_transcript.delta → Quell-Untertitel + Verzögerungsmessung
       session.output_transcript.delta → Ziel-Untertitel + Verzögerungsmessung
       session.usage.updated → Laufzeit und Kosten im Popup
       session.closed → Ende; bei Limit oder Netzverlust automatische neue Sitzung
       error → Hinweis, die Sitzung läuft weiter
```

Der Datenkanal ist vorab ausgehandelt (`transport.dcid`, WARP-Schritt) und
spart beim Start einen Roundtrip; ältere Server ohne diese Funktion erhalten
automatisch einen normalen Kanal.

## Verzögerung

GPT-Live dolmetscht vollständig und spricht dabei in eigenem Tempo. Deutsch ist
länger als Englisch, deshalb würde der Rückstand bei schnellen Sprechern ohne
Regelung immer weiter wachsen (gemessen: über 20 s nach einer Minute). Die
Erweiterung misst die Verzögerung live, indem sie Namen und Fachwörter im
englischen und deutschen Transkript auf der gemeinsamen Sitzungszeitachse
abgleicht (`src/offscreen/lag-monitor.ts`), und regelt in drei Stufen
(`src/offscreen/live-session.ts`), solange die Quelle spricht:

1. ab 5 s: stiller Kontext (`session.thinking.append`) – das Modell verdichtet,
   ohne den laufenden Satz abzubrechen,
2. ab 9 s: der Rückstand wird an der nächsten deutschen Satzgrenze übersprungen
   (`session.instructions.append`),
3. ab 14 s: eine frische Sitzung übernimmt mit Überblendung.

Nach dem Ende der Quelle wird nie abgeschnitten. Gemessen mit `gpt-live-1`:
Interview-Tempo (169 Wörter/min) vollständig bei 2–6 s, Extremtempo
(238 Wörter/min ohne Pause) begrenzt statt endlos wachsend.

Es gibt keine dreiteilige STT→Chat→TTS-Pipeline mehr im Extension-Code:
Resampling, PCM-Packaging und TTS-Playback entfallen – WebRTC verhandelt das
Audioformat per SDP. Die Session-Anweisungen leiten das Modell zum reinen
Dolmetschen (keine Antworten, keine Kommentare, keine Befehlsausführung aus
dem Quellton).

## Audioverhalten der Chrome-Erweiterung

GPT-Live hört das Tab-Audio direkt; die Player-Lautstärke bleibt deshalb auf
100 %. Den Originalton regelt der **Original**-Regler im Popup (0 % = nur
Deutsch). Darunter wirkt die automatische Absenkung:
der Originalton bleibt auf dem eingestellten Pegel, solange keine deutsche Ausgabe hörbar ist.
Ein RMS-Monitor der tatsächlich dekodierten Zielspur steuert den Mix: 28 %
Original bei überlappender Quellsprache, 60 % bei Atmo während des Dubbings.
220 ms Haltezeit verbinden Silben; weiche Pegelrampen vermeiden harte Kanten.
Silero erkennt lokal Quellsprache, nicht deren Sprache. Die Einschränkung auf
Englisch erfolgt durch den Modellprompt, nicht durch einen garantierten Sprachfilter.
Bei VAD-Ausfall bleibt ein vereinfachter ausgabegesteuerter Mix aktiv.
Bei stummgeschalteter Zielstimme bleibt das Original vollständig erhalten.

Der gemeinsame Ausgang besitzt keinen klangfärbenden Master-Kompressor. Ein
Soft-Knee-Summenbegrenzer mit Reserve bis ±2 greift erst oberhalb von 0,8 ein,
ohne Oversampling und ohne Lookahead, damit das Original bildsynchron bleibt.

Die neuen Mixpegel sind Startwerte, keine universelle Lautheits- oder
Studio-Dubbing-Garantie. Sprache, Musik und Raketenklang liegen im selben
Quellmix; ohne Quellentrennung kann die englische Stimme nicht isoliert entfernt werden.

## Voraussetzungen und Build

- Node.js 20.19+, 22.13+ oder 24+
- Chrome 116 oder neuer
- ein OpenAI-Projekt-API-Key mit **GPT-Live-Zugriff**
- ein lokal erreichbarer Server (Standard `http://127.0.0.1:8787`)

```bash
cp .env.example .env.local   # OPENAI_API_KEY + LIVE_TRANSLATE_SERVER_TOKEN eintragen
npm install
npm run check
```

Der ladbare Build liegt anschließend in `dist/`.

## Backend starten

Am einfachsten läuft der Server dauerhaft im Hintergrund (macOS-LaunchAgent,
startet beim Login und nach einem Absturz neu):

```bash
npm run service:install     # einmalig; erneut ausführen lädt neuen Servercode
npm run service:uninstall   # entfernen
```

Alternativ im Vordergrund:

```bash
npm run server # liest .env.local
# optional: LIVE_TRANSLATE_HOST, LIVE_TRANSLATE_PORT, LIVE_TRANSLATE_ALLOWED_ORIGIN
```

`GET /api/health` prüft Token und Origin für die Statusanzeige im Popup und
öffnet dabei die TLS-Verbindung zu OpenAI vor, sodass der Klick auf Start den
Verbindungsaufbau spart. Der Server nimmt außerdem `POST /api/live/session` mit Origin-Check
(`chrome-extension://` bzw. konfigurierte Origin) und zeitkonstantem
Token-Vergleich entgegen und reicht SDP + Übersetzungskonfiguration an
`POST /v1/live/sessions` mit der serverseitigen Dubbing-Konfiguration weiter. Er prüft die
OpenAI-Antwort und gibt nur die Sitzungs-ID und das WebRTC-SDP an die Extension
zurück. Abgebrochene Browser-Anfragen brechen auch die laufende Serveranfrage
ab; die Zeitgrenze gilt bis zum vollständig gelesenen Antwortkörper.

## Installation

1. `chrome://extensions` öffnen.
2. Den Entwicklermodus aktivieren.
3. **Entpackte Erweiterung laden** wählen.
4. Den Ordner `dist/` auswählen.
5. Ein Video starten, das Extension-Popup öffnen und einmalig Server-URL
   sowie Zugriffstoken unter „Einstellungen“ eintragen (der Punkt dort zeigt,
   ob der Server bereit ist).

Bedienung:

- **Start/Stop** im Popup oder **⌥⇧T** (Alt+Shift+T) im Video-Tab, auch im Vollbild.
  Das Kürzel lässt sich unter `chrome://extensions/shortcuts` ändern.
- **Stimme** und **Quelle** (Englisch oder alle Sprachen): ein Wechsel startet
  die laufende Übersetzung automatisch neu.
- **Deutsch** und **Original**: getrennte Lautstärken.
- **Untertitel** und **+ Original** (zweisprachig); die Untertitel sitzen über
  dem Video und skalieren mit seiner Größe.
- Unten im Popup: übersetzter Tab, gemessene Verzögerung, Laufzeit und Kosten.
Es ist kein Responses-Backend und keine Websuche konfiguriert. Unerwartete
Delegationsereignisse führen den Dolmetschermodus fort; wiederholte Abweichung
stoppt die Sitzung mit einer sichtbaren Fehlermeldung.

Grundlage ist die offizielle OpenAI-Dokumentation für
[GPT-Live](https://developers.openai.com/api/docs/guides/live),
[WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
und [Sessions](https://developers.openai.com/api/docs/guides/live-conversations).

## Datenschutz

Der OpenAI-API-Key der Erweiterung liegt ausschließlich auf dem eigenen
Server (Umgebung, nie im Repo, nie in Logs). Die macOS-App speichert ihren
Schlüssel im lokalen Schlüsselbund. Die Extension speichert nur
Verbindungsdaten, Stimme und Ausgabeeinstellungen in `chrome.storage.local`; der Key
erreicht den Browser nie. Beim Laden werden alle nicht zur aktuellen
Konfiguration gehörenden Storage-Schlüssel automatisch entfernt, einschließlich alter API-Schlüssel.

Privilegierte Runtime-Nachrichten (Start, Stop, Transkripte, Status) akzeptieren
Service Worker, Popup und Offscreen-Dokument nur von Extension-eigenen
Absendern, nie aus dem Renderer einer Webseite.

Abrechnung: GPT-Live-Sitzungen werden pro Sekunde abgerechnet (WebRTC-Init
mit 15-s-Gutschrift laut OpenAI-Doku); Backend-Nutzung separat. Details unter
Kostenoptimierung in der OpenAI-Doku.

## Architektur

```text
Popup
  └─ Background Service Worker
       ├─ one-shot Tab-Capture-ID unmittelbar vor dem Offscreen-Start
       ├─ Content Script (Overlay + nativer Fullscreen-TextTrack)
       └─ Offscreen AudioContext
            ├─ ein Originalpfad: ausgabegesteuert 100 % / 60 % / 28 %
            ├─ AudioWorklet: lückenloser Roh-Audio-Capturepfad
            ├─ lokaler Worker: Silero VAD 6.2.1 via ONNX/WASM
            ├─ Ausgang: transparenter Soft-Knee-Summenbegrenzer
            └─ GptLiveTranslator (src/offscreen/live.ts)
                 ├─ WebRTC PeerConnection + oai-events-Datenkanal
                 ├─ Remote-Track → translatedGain → Ausgang
                 └─ live-protocol.ts: Antwort- + Event-Parser
Server (server/)
  ├─ live-server.mjs: Origin-/Token-Check, POST /api/live/session
  └─ live-session.mjs: Anweisungen + Sitzungskonfiguration
```

Wichtige Dateien:

- `src/offscreen/main.ts` – Audio-Graph, Ducking und Sitzungslebenszyklus
- `src/offscreen/live.ts` – WebRTC-Adapter (Offer, Answer, Remote-Audio)
- `src/offscreen/live-protocol.ts` – Antwort-/Event-Parser, Endpoint-Builder
- `server/live-server.mjs` – vertrauenswürdiges Backend
- `server/live-session.mjs` – Sitzungskonfiguration
- `server/dubbing-prompt.mjs` – Zugriff auf das gemeinsame Übersetzungsprofil
- `macos/Sources/LiveTranslateCore/Resources/translation-profile.json` – Modell, Stimmen und Prompt für beide Apps
- `macos/Sources/LiveTranslate/` – natives Menüleisten-Pop-up und Sitzungssteuerung
- `macos/Sources/LiveTranslateCore/` – WebSocket, Live-Protokoll und begrenzte PCM-Puffer
- `macos/Sources/LiveTranslateAudio/` – Core Audio Taps, Silero VAD, AVAudioEngine und Schlüsselbund
- `src/offscreen/dubbing-mix.ts` – dekodierte Ausgabeaktivität und Originalpegel
- `src/offscreen/neural-vad.ts` – lokaler AudioWorklet-/Worker-VAD-Pfad
- `src/offscreen/vad-worker.ts` – Silero-ONNX-Inferenz und rekurrenter Zustand
- `src/offscreen/voice-detector.ts` – Wahrscheinlichkeitshysterese und Pegellogik
- `src/subtitle-state.ts` – getrennte Source-/Target-Untertitelzustände
- `src/background.ts` – Tab-/Offscreen-Koordination
- `src/content.ts` – Overlay/Fullscreen-Adapter

## Qualitätsprüfung

```bash
npm run typecheck  # striktes TypeScript
npm run lint       # TypeScript-ESLint
npm test           # Audio-, Untertitel-, Protokoll- und Settings-Tests
npm run coverage   # Tests plus 90/75/80-Mindestwerte
npm run bundle     # reproduzierbarer MV3-Build
npm run check      # alles oben plus Dependency-Audit
```

Dieselbe Prüfung läuft bei jedem Push und Pull Request in GitHub Actions mit
Node.js 24. Ein zusätzlicher macOS-Job prüft Swift-Tests, App-Build und Signatur.

## Grenzen

- Die Erweiterung benötigt das eigene Backend, die macOS-App nicht.
- Quelle „Englisch“ ist am zuverlässigsten; „Alle Sprachen“ wirkt wie in der
  macOS-App als Modellanweisung, nicht als garantierter Sprachfilter.
- Bei sehr schnellen Sprechern ohne Pausen hält die Regelung die Verzögerung
  begrenzt, indem sie einzelne Sätze überspringt.
- Zielsprache ist Deutsch; eine Stimme wird vor Beginn der Sitzung ausgewählt.
- GPT-Live braucht bei durchgehender Sprache typischerweise 2–6 s; Deutsch
  wartet oft auf das Verb am Satzende.
- Eine absolute Garantie für jedes übersetzte Wort ist bei externen Modellen
  nicht seriös. Lokal nachweisbar sind Transport, WebRTC-Lifecycle und
  PCM-Sättigung; Übersetzungsqualität braucht eine bilinguale
  Golden-Set-Abnahme.
- Chrome-interne Seiten und der Chrome Web Store können nicht aufgenommen
  werden.
- Ein fremdes, cross-origin `<iframe>` im eigenen nativen Vollbild kann aus
  Chromes Top-Frame-Sicherheitsgrenze heraus keine Extension-Untertitel
  anzeigen; direktes Video- und Container-Vollbild sind abgedeckt.
