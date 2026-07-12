# Verifikation

Diese Datei trennt nachgewiesene Eigenschaften von Modellqualität, die ohne
eine bilinguale menschliche Referenz nicht seriös garantiert werden kann.

## Automatisierte Abnahme

```bash
npm ci
npm run check
```

`npm run check` umfasst striktes TypeScript, alle Unit-/Integrationsprüfungen,
den vollständigen MV3-Build und `npm audit --audit-level=moderate`. GitHub
Actions führt denselben Befehl bei Pushes und Pull Requests mit Node.js 24 aus.

Die Tests decken unter anderem ab:

- exakt 10 % Quellpegel während Sprache und exakt 100 % außerhalb;
- fail-open bei VAD-, Gemini- und Netzfehlern;
- 20-ms-Capture und modellspezifische 100-ms-Gemini-Chunks;
- Setup-Preroll mit expliziter Sample-Bilanz;
- Dual-Socket-GoAway-Handover mit eindeutiger Sample-Grenze, gepufferter FIFO
  und gepulstem Backpressure-Drain ohne Doppelversand;
- Verwerfen alter Resumption-Tokens nach `resumable: false`;
- getrennte Fallbacks für Transkript, Resumption und Kontextkompression;
- Rest-PCM vor `audioStreamEnd` und einen festen, nicht als Server-Ack
  missverstandenen Drain-Zeitraum beim Beenden;
- Turn-Hüllkurven, Interruption und `generationComplete`;
- idempotenten one-shot Tab-Capture-Start;
- geordneten Stop, Session-Races und stale Output-Updates;
- den Chrome-116-Offscreen-Fallback über `runtime.getContexts`;
- harte `tabCapture`-Abbrüche mit Tab-/Session-Recheck;
- Untertitel-Reparenting Body → Fullscreen-Container → Body;
- lokale Silero-Modellintegrität und MV3-CSP.

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
Whisper-Large-v3-Turbo-Zeitreferenz. Eine zweite, unabhängige Transkriptmaske
und sechs chronologische Abschnitte je Encoding bestätigten die Richtung; der
Core-Recall stieg in allen zwölf Fold-Auswertungen um 0,133–0,509 Prozentpunkte.
Whisper ist dabei keine menschliche Ground Truth. Fehlende VAD-Treffer bedeuten keinen Gemini-Verlust:
Silero steuert nur den Original-Gain; der Gemini-Uplink wird nie durch VAD
gegatet.

## PCM-Sättigung

Ein echter Chrome-`OfflineAudioContext`-Render des vollständigen Films bewies,
dass `DynamicsCompressorNode` kein Brickwall-Limiter ist.

| Gemini-Eingang | Peak nach 16 kHz | saturierte Samples | Sprachkern-RMS |
|---|---:|---:|---:|
| früher, Makeup 6,8 | 1,442328 | 77.865 / 0,236752 % | −9,912 dBFS |
| Makeup 4,0 | 1,247468 | 4.708 / 0,014315 % | −11,686 dBFS |
| aktuell, Makeup 6,8 + Soft-Knee | 0,979714 | **0** | −9,957 dBFS |

Der aktuelle Limiter entfernt damit die Sättigung bei nur 0,045 dB Differenz
im Sprachkern.

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

## Ehrliche Grenze

Transport, Clipping, Pegellogik und Lifecycle sind lokal deterministisch
prüfbar. Die semantische Übersetzungsgenauigkeit und die serverseitige Latenz
von `gemini-3.5-live-translate-preview` benötigen dagegen wiederholte echte
Gemini-Läufe mit einer manuell geprüften englisch–Zielsprache-Referenz. Eine
Behauptung „jedes Wort garantiert perfekt“ wäre ohne diese Ground Truth falsch.
