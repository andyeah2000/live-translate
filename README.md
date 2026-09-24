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
       session.input_transcript.delta → Quell-Untertitel (nur Dual-Modus)
       session.output_transcript.delta → Ziel-Untertitel
       session.closed → geordneter Stop mit finaler Usage
       error → sichtbarer Fehler
```

Es gibt keine dreiteilige STT→Chat→TTS-Pipeline mehr im Extension-Code:
Resampling, PCM-Packaging und TTS-Playback entfallen – WebRTC verhandelt das
Audioformat per SDP. Die Session-Anweisungen leiten das Modell zum reinen
Dolmetschen (keine Antworten, keine Kommentare, keine Befehlsausführung aus
dem Quellton).

## Audioverhalten der Chrome-Erweiterung

Der Originalton bleibt bei 100 %, solange keine deutsche Ausgabe hörbar ist.
Ein RMS-Monitor der tatsächlich dekodierten Zielspur steuert den Mix: 28 %
Original bei überlappender Quellsprache, 60 % bei Atmo während des Dubbings.
220 ms Haltezeit verbinden Silben; weiche Pegelrampen vermeiden harte Kanten.
Silero erkennt lokal Quellsprache, nicht deren Sprache. Die Einschränkung auf
Englisch erfolgt durch den Modellprompt, nicht durch einen garantierten Sprachfilter.
Bei VAD-Ausfall bleibt ein vereinfachter ausgabegesteuerter Mix aktiv.
Bei stummgeschalteter Zielstimme bleibt das Original vollständig erhalten.

Der gemeinsame Ausgang besitzt keinen klangfärbenden Master-Kompressor. Ein
4×-oversampelter Soft-Knee-Summenbegrenzer greift erst in den obersten 1,94 dB
ein.

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

Auf diesem Mac ist inzwischen ein automatischer Hintergrunddienst installiert:
siehe [SERVER_SERVICE.md](SERVER_SERVICE.md). Kein Terminalstart nötig.
Der folgende manuelle Start ist nur für andere Installationen gedacht.

```bash
npm run server # liest .env.local
# optional: LIVE_TRANSLATE_HOST, LIVE_TRANSLATE_PORT, LIVE_TRANSLATE_ALLOWED_ORIGIN
```

Der Server nimmt nur `POST /api/live/session` mit Origin-Check
(`chrome-extension://` bzw. konfigurierte Origin) und zeitkonstantem
Token-Vergleich entgegen und reicht SDP + Übersetzungskonfiguration an
`POST /v1/live/sessions` mit der serverseitigen Dubbing-Konfiguration weiter. Er gibt die
OpenAI-Antwort (`session.id` + `transport.sdp`) unverändert an die Extension
zurück.

## Installation

1. `chrome://extensions` öffnen.
2. Den Entwicklermodus aktivieren.
3. **Entpackte Erweiterung laden** wählen.
4. Den Ordner `dist/` auswählen.
5. Ein englisches Video starten, das Extension-Popup öffnen und Server-URL
   sowie Zugriffstoken eintragen.

Das Popup bietet Server-URL, Zugriffstoken, Untertitel, Dual-Untertitel und
die Lautstärke der Zielspur. Die Handoff-Konfiguration bleibt absichtlich
fixiert: nur englische Sprache möglichst früh ins Deutsche übersetzen. Die Stimme ist auswählbar; ein Wechsel startet die aktive Sitzung automatisch neu.
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
       ├─ one-shot Tab-Capture-ID direkt vor dem Offscreen-Start
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
- Die Erweiterung übersetzt Englisch. In der macOS-App ist zusätzlich eine
  automatische Quellsprache auswählbar; die Auswahl wirkt als Modellanweisung.
- Zielsprache ist Deutsch; eine Stimme wird vor Beginn der Sitzung ausgewählt.
- Live-Übersetzung hat netz- und modellabhängig eine merkliche Verzögerung.
- Eine absolute Garantie für jedes übersetzte Wort ist bei externen Modellen
  nicht seriös. Lokal nachweisbar sind Transport, WebRTC-Lifecycle und
  PCM-Sättigung; Übersetzungsqualität braucht eine bilinguale
  Golden-Set-Abnahme.
- Chrome-interne Seiten und der Chrome Web Store können nicht aufgenommen
  werden.
- Ein fremdes, cross-origin `<iframe>` im eigenen nativen Vollbild kann aus
  Chromes Top-Frame-Sicherheitsgrenze heraus keine Extension-Untertitel
  anzeigen; direktes Video- und Container-Vollbild sind abgedeckt.
