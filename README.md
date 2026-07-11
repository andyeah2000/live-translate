# Live Translate

Eine fokussierte Chrome-Erweiterung für englische Videos und Livestreams. Sie
sendet Tab-Audio direkt an **Gemini 3.5 Live Translate**, zeigt die deutsche
Live-Transkription als Untertitel und spielt Geminis native Übersetzungsstimme
ab. Es gibt keinen zweiten Sprachdienst und keinen Zwischenserver.

## Audioverhalten

Der Originalton läuft normalerweise unverarbeitet mit 100 %. Erkennt der
lokale Analysepfad Sprache im englischen Quellvideo, wird der komplette
Originalmix weich auf den eingestellten Pegel abgesenkt (Standard: 10 %).
Sobald die Quellsprache endet, kehren Musik, Raketenklang und Atmo mit einer
kurzen, pumpfreien Ausblendung (typisch unter 250 ms) auf 100 % zurück.

Die Spracherkennung hört ausschließlich den Quellstream. Geminis zeitversetzte
Übersetzungsstimme kann das Ducking daher nicht künstlich verlängern. Ein
physisch getrennter Dry-Bypass erlaubt außerdem, das Ducking vollständig zu
deaktivieren.

## Voraussetzungen und Build

- Node.js 20 oder neuer
- Chrome 116 oder neuer
- Gemini API-Key mit Zugriff auf `gemini-3.5-live-translate-preview`

```bash
npm install
npm run check
```

Der ladbare Build liegt anschließend in `dist/`.

## Installation

1. `chrome://extensions` öffnen.
2. Den Entwicklermodus aktivieren.
3. **Entpackte Erweiterung laden** wählen.
4. Den Ordner `dist/` auswählen.
5. Ein englisches Video starten, das Extension-Popup öffnen und den Gemini-Key
   eintragen.

Ein API-Key lässt sich in [Google AI Studio](https://aistudio.google.com/apikey)
erstellen. Die technische Grundlage ist die offizielle
[Gemini Live Translation API](https://ai.google.dev/gemini-api/docs/live-api/live-translate).

## Datenschutz

Der Gemini-Key wird ausschließlich in `chrome.storage.local` des lokalen
Browserprofils gespeichert und direkt an
`generativelanguage.googleapis.com` gesendet. Er wird nie in das Repository,
Untertitel oder Logs geschrieben. Alte OpenAI- und xAI-Schlüssel früherer
Versionen werden bei der ersten Migration aktiv aus dem Extension-Storage
entfernt.

## Architektur

```text
Popup
  └─ Background Service Worker
       ├─ Tab Capture
       ├─ Content Script (Untertitel-Overlay)
       └─ Offscreen AudioContext
            ├─ Dry-Originalpfad: exakt 100 %
            ├─ Dynamischer Originalpfad: 100 % ↔ konfigurierter Pegel
            ├─ lokaler Quellsprach-Detektor (nur Steuerung)
            ├─ optionaler KI-Sprachfilter + Limiter
            └─ Gemini Live Translate
                 ├─ 16-kHz-PCM-Uplink
                 ├─ 24-kHz-Übersetzungsaudio
                 └─ Übersetzungs-Transkription
```

Wichtige Dateien:

- `src/offscreen/main.ts` – Audio-Graph, Ducking und Sitzungslebenszyklus
- `src/offscreen/voice-detector.ts` – Quellsprach-Erkennung und Pegellogik
- `src/offscreen/gemini.ts` – Gemini-WebSocket, Reconnect und Wiedergabe
- `src/offscreen/pcm.ts` – Anti-Aliasing, Resampling und PCM-Konvertierung
- `src/background.ts` – Tab-/Offscreen-Koordination
- `src/content.ts` – Untertitel-Overlay

## Qualitätsprüfung

```bash
npm run typecheck  # striktes TypeScript
npm test           # Audio-, Ducking-, Settings- und Protokolltests
npm run bundle     # reproduzierbarer MV3-Build
npm run check      # alles oben plus Dependency-Audit
```

## Grenzen

- Die Erweiterung ist für englische Quellvideos optimiert. Die Gemini-API
  erkennt die Eingangssprache automatisch und bietet derzeit keine separate
  `sourceLanguageCode`-Sperre.
- Sehr sprachähnliche Musik kann eine rein lokale Pegel-/Bandanalyse in seltenen
  Fällen kurz als Stimme bewerten.
- Live-Übersetzung hat eine Gemini-bedingte Verzögerung von einigen Sekunden.
- Chrome-interne Seiten und der Chrome Web Store können nicht aufgenommen
  werden.
