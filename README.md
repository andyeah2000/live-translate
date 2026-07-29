# Live Translate

Eine fokussierte Chrome-Erweiterung für englische Videos und Livestreams. Sie
sendet Tab-Audio direkt an **Gemini 3.5 Live Translate**, zeigt die übersetzte
Live-Transkription als Untertitel und spielt Geminis native Übersetzungsstimme
ab. Es gibt keinen zweiten Sprachdienst und keinen Zwischenserver.

## Audioverhalten

Der Originalton läuft normalerweise unverarbeitet mit 100 %. Erkennt die
vollständig lokale **Silero VAD 6.2.1** Sprache im englischen Quellvideo, wird der komplette
Originalmix weich und unveränderlich auf **10 %** abgesenkt.
Eine 220-ms-Raised-Cosine-Hüllkurve vermeidet den hörbaren Pegelsprung. Sobald
die Quellsprache endet, kehren Musik, Raketenklang und Atmo mit einer langsamen
700-ms-S-Curve pumpfrei auf 100 % zurück – ein Raketenstart ist sofort wieder
in voller Lautstärke da. Die zeitversetzte Gemini-Stimme spricht bewusst über
den vollen Originalpegel weiter; das Ducking hängt ausschließlich an der
Originalstimme.

Auch Geminis Übersetzungsstimme wird nicht blockweise hart geschaltet: Jeder
zusammenhängende Sprach-Turn erhält einen kurzen 25-ms-Fade-in und
30-ms-Fade-out. Nur die äußeren PCM-Kanten werden zusätzlich für 5 ms
entklickt; innere Netzwerk-Chunks bleiben lückenlos. Eine von Gemini ausdrücklich
unterbrochene Antwort klingt innerhalb von 60 ms aus, statt hart abzureißen.

Die neuronale Spracherkennung verarbeitet lückenlose 32-ms-Frames ausschließlich
lokal im Browser. Sie hört nur den Quellstream; Geminis zeitversetzte
Übersetzungsstimme kann das Ducking daher nicht künstlich verlängern. Ein
einziger Originalpfad führt das vollständige Quellsignal direkt zum Ausgang;
nur sein Gain wird von der VAD gesteuert. Falls das lokale Modell wider
Erwarten ausfällt, bleibt die Übersetzung aktiv und der Originalton wird als
sichere Voreinstellung innerhalb von 100 ms auf 100 % durchgeschaltet. Dasselbe gilt,
während Gemini verbindet oder neu verbindet sowie bei Netz-Backpressure.

Digitale Stille (pausiertes Video, stummer Tab) wird nach 1,5 s erkannt: Der
Uplink pausiert mit einem `audioStreamEnd`, wie es der Live-API-Guide für
Streampausen über einer Sekunde empfiehlt. Das spart Token-Budget, vermeidet
halluzinierte Turns in langen Ruhephasen (z. B. vor einem Raketenstart) und
läuft beim ersten echten Ton nahtlos weiter. Die Schwelle liegt bei einem
PCM16-LSB – echte leise Atmo wird niemals gegatet.

Der Gemini-Eingang ist eine feste, getestete Sprachpipeline: 80-Hz-Hochpass
gegen Raketen- und Raumrumpeln, Kompression plus Makeup für leise Funk-Callouts,
Anti-Aliasing, 16-kHz-Resampling und ein deterministischer PCM-Soft-Limiter.
Diese Bearbeitung ist
nur für Gemini hörbar; der Originalton bleibt klanglich unverändert.

Gemini-Sitzungen werden mit Resumption-Checkpoints und Sliding-Window-
Kompression über die normalen Verbindungsgrenzen hinaus fortgesetzt. Bei einem
planmäßigen `goAway` verbindet der Client einen zweiten Socket parallel: Der
alte spielt bereits empfangene Ausgabe zu Ende, während neues Eingabeaudio ab
einer eindeutigen Sample-Grenze lokal wartet. Nach `setupComplete` leert ein
Backpressure-gesteuerter Sendepump die FIFO exakt einmal in den neuen Socket.
Damit funktionieren sowohl normale Resumption als auch ein von Gemini
erzwungener frischer Wechsel ohne Audioverlust oder Doppelversand. Hängt ein
Kandidat, begrenzt eine 10-s-Obergrenze die wartende FIFO auf das frischeste
Audio; zwischen zwei Handover-Versuchen läuft der Uplink auf dem noch offenen
alten Socket weiter. Initiales
Setup und kurze ungeplante Netzunterbrechungen besitzen einen begrenzten
500-ms-Preroll. Wird schon das allererste Setup wiederholt abgelehnt – etwa
bei ungültigem API-Key –, endet der Start nach zwei schnellen Versuchen mit
einem konkreten Hinweis statt im minutenlangen Backoff. Eine Sample-Bilanz
weist `captured`, `sent`, `pending` und
unvermeidbar `dropped` getrennt aus.

Beim Stream-Ende werden Worklet-Restblock und partieller PCM-Chunk vor
`audioStreamEnd` gesendet. Da das Raw-Protokoll dafür keine korrelierbare
Quittung liefert, deutet der Client weder `turnComplete` noch
`generationComplete` fälschlich als Bestätigung, sondern verwendet ein festes,
begrenztes Drain-Fenster und spielt bereits empfangene Ausgabe zu Ende.

Der gemeinsame Ausgang besitzt keinen klangfärbenden Master-Kompressor. Ein
4×-oversampelter Soft-Knee-Summenbegrenzer greift erst in den obersten 1,94 dB
ein. Beim SpaceX-Quellfilm bleibt der Originalpfad dadurch messtechnisch
transparent; ein synthetischer gleichphasiger Worst-Case-Mix bleibt clipfrei.

Die Dynamik wurde gegen den vollständigen 34:15-Minuten-SpaceX-Film
**Critical Path** kalibriert. Die lokale VAD analysiert das breitbandige Signal
ohne aggressiven Sprach-Hochpass. Der adaptive 384–736-ms-Sprach-Hangover
verbindet kurze Wortpausen, bevor eine 700-ms-S-Curve die Atmo weich auf 100 %
zurückführt.

Zwei unabhängige Encodings ergaben über jeweils 64.235 VAD-Frames eine
Wortkern-Vollabdeckung von 92,99–93,49 %, mindestens irgendeine
VAD-Abdeckung bei 97,95–98,16 % der Wörter und 13,02–13,31 Pegelwechsel pro
Minute. Die VAD steuert ausschließlich das hörbare Ducking; der Gemini-Uplink
bleibt kontinuierlich und verliert deshalb auch Wörter ohne VAD-Treffer nicht.
Alle Messwerte und ihre Grenzen stehen in [VERIFICATION.md](VERIFICATION.md).

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

Das Popup enthält die direkten Produktkontrollen: API-Key, Zielsprache,
Sprechweise (Vortrag & Doku / Schneller Dialog als getestete VAD-Presets),
Stimme (automatisch oder eine Prebuilt-Stimme, mit automatischem Fallback,
falls das Modell sie ablehnt), Untertitel an/aus, Original + Übersetzung als
Dual-Untertitel, „Zielsprache nachsprechen" (`echoTargetLanguage`) und die
Lautstärke der Gemini-Stimme. Sprachoptimierung, Übersetzungsaudio und
dynamisches 10/100-Ducking bleiben feste Bestandteile der einen
Produktpipeline. Ein verstecktes Experiment `rawModelAudio`
(per DevTools: `chrome.storage.local.set({ rawModelAudio: true })`) schickt
Gemini das nur hochpassgefilterte Originalsignal, um den Prosodie-Erhalt von
Gemini 3.5 ohne Kompressor zu testen; Wirkung ab dem nächsten Start.

Ein API-Key lässt sich in [Google AI Studio](https://aistudio.google.com/apikey)
erstellen. Die technische Grundlage ist die offizielle
[Gemini Live Translation API](https://ai.google.dev/gemini-api/docs/live-api/live-translate).

## Datenschutz

Der Gemini-Key wird ausschließlich in `chrome.storage.local` des lokalen
Browserprofils gespeichert und direkt an
`generativelanguage.googleapis.com` gesendet. Beim Start prägt der Client
daraus kurzlebige Einmal-Tokens (`auth_tokens`-API) und verbindet damit über
den dafür vorgesehenen `BidiGenerateContentConstrained`-Endpunkt: Der
Langzeit-Key wandert nie in eine WebSocket-URL, und ein abgelehnter Key
scheitert sofort mit einer klaren Meldung statt nach minutenlangem Reconnect.
Ist die Token-API nicht erreichbar oder lehnt der Server einen Token-Socket
ab, wechselt der Client sofort und dauerhaft auf die direkte
Key-Verbindung – die Übersetzung hängt nie an der Token-Infrastruktur. Der Key wird
nie in das Repository, Untertitel oder Logs geschrieben. Beim Laden werden
alle nicht zur aktuellen Gemini-Konfiguration gehörenden Storage-Schlüssel
automatisch entfernt.
Privilegierte Runtime-Nachrichten (Start, Stop, Transkripte, Status)
akzeptieren Service Worker, Popup und Offscreen-Dokument nur von
Extension-eigenen Absendern, nie aus dem Renderer einer Webseite.

## Architektur

```text
Popup
  └─ Background Service Worker
       ├─ one-shot Tab-Capture-ID direkt vor dem Offscreen-Start
       ├─ Content Script (Overlay + nativer Fullscreen-TextTrack)
       └─ Offscreen AudioContext
            ├─ ein Originalpfad: weich 100 % ↔ fest 10 %
            ├─ AudioWorklet: lückenloser Roh-Audio-Capturepfad
            ├─ lokaler Worker: Resampling + Silero VAD 6.2.1 via ONNX/WASM
            ├─ Gemini-Eingang: Hochpass → Kompressor → Resampler → Soft-Limiter
            ├─ Ausgang: transparenter Soft-Knee-Summenbegrenzer
            └─ Gemini Live Translate
                 ├─ kontinuierlicher 16-kHz-PCM-Uplink in 100-ms-Chunks
                 ├─ Stille-Gating mit audioStreamEnd bei Streampausen
                 ├─ 24-kHz-Übersetzungsaudio
                 ├─ Original- und Übersetzungs-Transkription
                 └─ paralleler Dual-Socket-GoAway-Handover
```

Wichtige Dateien:

- `src/offscreen/main.ts` – Audio-Graph, Ducking und Sitzungslebenszyklus
- `src/offscreen/neural-vad.ts` – lokaler AudioWorklet-/Worker-VAD-Pfad
- `src/offscreen/vad-worker.ts` – Silero-ONNX-Inferenz und rekurrenter Zustand
- `src/offscreen/voice-detector.ts` – Wahrscheinlichkeitshysterese und Pegellogik
- `src/offscreen/gemini.ts` – Gemini-WebSocket, Reconnect und Wiedergabe
- `src/offscreen/pcm.ts` – Anti-Aliasing, Resampling und PCM-Konvertierung
- `src/offscreen/soft-limiter.ts` – deterministische Peak-Begrenzung
- `src/background.ts` – Tab-/Offscreen-Koordination
- `src/content.ts` – Untertitel-Overlay

## Qualitätsprüfung

```bash
npm run typecheck  # striktes TypeScript
npm test           # Audio-, Ducking-, Settings- und Protokolltests
npm run bundle     # reproduzierbarer MV3-Build
npm run check      # alles oben plus Dependency-Audit
```

Dieselbe Prüfung läuft bei jedem Push und Pull Request in GitHub Actions mit
Node.js 24. Die Actions sind auf verifizierte Commit-SHAs gepinnt.

## Grenzen

- Die Erweiterung ist für englische Quellvideos optimiert. Die Gemini-API
  erkennt die Eingangssprache automatisch und bietet derzeit keine separate
  `sourceLanguageCode`-Sperre.
- Silero erkennt Sprachaktivität, aber nicht die gesprochene Sprache. Im für
  englische Videos gedachten Modus wird daher jedes erkannte Sprachsegment als
  englische Quellsprache behandelt.
- Extrem menschenähnlicher Gesang kann wie bei jeder VAD als Sprache gelten.
- Live-Übersetzung hat eine Gemini-bedingte Verzögerung von einigen Sekunden.
- Eine absolute Garantie für jedes übersetzte Wort ist bei einem externen
  Preview-Modell nicht seriös. Lokal nachweisbar sind dagegen lückenloser
  Normal-/GoAway-Transport, Restchunk-Flush und null PCM-Sättigung im
  vollständigen Referenzvideo.
- Chrome-interne Seiten und der Chrome Web Store können nicht aufgenommen
  werden.
- Ein fremdes, cross-origin `<iframe>` im eigenen nativen Vollbild kann aus
  Chromes Top-Frame-Sicherheitsgrenze heraus keine Extension-Untertitel
  anzeigen; direktes Video- und Container-Vollbild sind abgedeckt.
