# Live Translate

Eine fokussierte Chrome-Erweiterung für englische Videos und Livestreams. Sie
sendet Tab-Audio direkt an **Gemini 3.5 Live Translate**, zeigt die deutsche
Live-Transkription als Untertitel und spielt Geminis native Übersetzungsstimme
ab. Es gibt keinen zweiten Sprachdienst und keinen Zwischenserver.

## Audioverhalten

Der Originalton läuft normalerweise unverarbeitet mit 100 %. Erkennt die
vollständig lokale **Silero VAD 6.2.1** Sprache im englischen Quellvideo, wird der komplette
Originalmix weich und unveränderlich auf **10 %** abgesenkt.
Eine 220-ms-Raised-Cosine-Hüllkurve vermeidet den hörbaren Pegelsprung. Sobald
die Quellsprache endet, kehren Musik, Raketenklang und Atmo mit einer langsamen
700-ms-S-Curve pumpfrei auf 100 % zurück.

Auch Geminis Übersetzungsstimme wird nicht blockweise hart geschaltet: Jeder
zusammenhängende Sprach-Turn erhält einen 90-ms-Fade-in und 140-ms-Fade-out.
Die inneren Netzwerk-Chunks bleiben lückenlos, damit die Stimme weder flattert
noch zwischen einzelnen Datenpaketen leiser wird. Auch eine von Gemini
unterbrochene Antwort klingt innerhalb von 60 ms aus, statt hart abzureißen.

Die neuronale Spracherkennung verarbeitet lückenlose 32-ms-Frames ausschließlich
lokal im Browser. Sie hört nur den Quellstream; Geminis zeitversetzte
Übersetzungsstimme kann das Ducking daher nicht künstlich verlängern. Ein
einziger Originalpfad führt das vollständige Quellsignal direkt zum Ausgang;
nur sein Gain wird von der VAD gesteuert. Falls das lokale Modell wider
Erwarten ausfällt, bleibt die Übersetzung aktiv und der Originalton wird als
sichere Voreinstellung sofort auf 100 % durchgeschaltet. Dasselbe gilt,
während Gemini verbindet oder neu verbindet sowie bei Netz-Backpressure.

Der Gemini-Eingang ist eine feste, getestete Sprachpipeline: 80-Hz-Hochpass
gegen Raketen- und Raumrumpeln, Kompression plus Makeup für leise Funk-Callouts,
Sicherheits-Limiter, Anti-Aliasing und 16-kHz-Resampling. Diese Bearbeitung ist
nur für Gemini hörbar; der Originalton bleibt klanglich unverändert.

Gemini-Sitzungen werden mit Resumption-Checkpoints und Sliding-Window-
Kompression über die normalen Verbindungsgrenzen hinaus fortgesetzt. Mehr als
750 ms WebSocket-Rückstau werden nicht später zeitversetzt abgespielt: Der Client
verwirft die alte Queue, schaltet das Original auf 100 % und verbindet frisch.

Die Dynamik wurde gegen den vollständigen 34:15-Minuten-SpaceX-Film
**Critical Path** kalibriert. Die lokale VAD analysiert das breitbandige Signal
ohne aggressiven Sprach-Hochpass. Der adaptive 320–640-ms-Sprach-Hangover
verbindet kurze Wortpausen, bevor eine 700-ms-S-Curve die Atmo weich auf 100 %
zurückführt.

Im reproduzierbaren A/B-Lauf über alle 64.235 VAD-Frames sank die Zahl der
Pegelwechsel von 20,96 auf 13,43 pro Minute (-35,9 %). Gleichzeitig stieg die
Abdeckung hochkonfidenter Whisper-Wortkerne von 90,53 % auf 92,66 %. Diese
Whisper-Zeitstempel dienen als relative Vergleichsreferenz, nicht als behauptete
menschliche Ground Truth.

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

Das Popup enthält nur vier direkte Produktkontrollen: API-Key, Zielsprache,
Untertitel an/aus und Lautstärke der Gemini-Stimme. Sprachoptimierung,
Übersetzungsaudio und dynamisches 10/100-Ducking bleiben feste Bestandteile
der einen Produktpipeline.

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
            ├─ ein Originalpfad: weich 100 % ↔ fest 10 %
            ├─ AudioWorklet: lückenloser Roh-Audio-Capturepfad
            ├─ lokaler Worker: Resampling + Silero VAD 6.2.1 via ONNX/WASM
            ├─ fester Gemini-Pfad: Hochpass → Kompressor → Limiter
            └─ Gemini Live Translate
                 ├─ 16-kHz-PCM-Uplink
                 ├─ 24-kHz-Übersetzungsaudio
                 └─ Übersetzungs-Transkription
```

Wichtige Dateien:

- `src/offscreen/main.ts` – Audio-Graph, Ducking und Sitzungslebenszyklus
- `src/offscreen/neural-vad.ts` – lokaler AudioWorklet-/Worker-VAD-Pfad
- `src/offscreen/vad-worker.ts` – Silero-ONNX-Inferenz und rekurrenter Zustand
- `src/offscreen/voice-detector.ts` – Wahrscheinlichkeitshysterese und Pegellogik
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
- Silero erkennt Sprachaktivität, aber nicht die gesprochene Sprache. Im für
  englische Videos gedachten Modus wird daher jedes erkannte Sprachsegment als
  englische Quellsprache behandelt.
- Extrem menschenähnlicher Gesang kann wie bei jeder VAD als Sprache gelten.
- Live-Übersetzung hat eine Gemini-bedingte Verzögerung von einigen Sekunden.
- Chrome-interne Seiten und der Chrome Web Store können nicht aufgenommen
  werden.
