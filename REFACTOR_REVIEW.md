# Dubbing review — 2026-09-12

## Nachtrag: Stimmen und direkter Eingang

- Stimmenauswahl im Popup; Server validiert die Stimme gegen seine Allowlist. Wechsel nach Stop/Start (API-Vorgabe).
- DIRECT: captureStream() des größten laufenden zugänglichen Medienplayers liefert Audio vor volume/muted; lokale WebRTC-Verbindung zum Offscreen-Dokument ohne STUN/TURN. Keine Videoübertragung, keine Änderung der Player-Lautstärke.
- TAB: Rückfall auf den vorhandenen Tab-Mix, wenn kein zugänglicher Medienplayer eine Audiospur liefert. Dort bleibt die Player-Lautstärke relevant. Modus und Einschränkung sind im Popup/Tooltip sichtbar.
- DRM, fremde Frames, Shadow-DOM-Player und dynamischer Austausch des Medienelements sind nicht universell abgedeckt. Nach Video-/Seitenwechsel neu starten.
- Pegelautomation verwendet unterbrechbare lineare Rampen statt überlappungsanfälliger Value-Curves. Chrome meldete einen DOMException-Tickfehler; die genaue Exception war im gelieferten Quelltext nicht enthalten.
- Architektur ist aktuell, aber keine pauschale Zertifizierung als fehlerfrei oder universell „Stand der Technik“.

Referenz: https://w3c.github.io/mediacapture-fromelement/ (captureStream-Audio unabhängig von Element-volume/muted).

## Ergebnis

Prüfung der aktiven Pipeline: Background/Popup/Settings, Content/Untertitel,
Offscreen-Audiograph, WebRTC/Protokoll, lokale VAD und Server.
Bestehende Änderungen wurden erhalten; kein pauschales Umschreiben funktionierender Module.

| Bereich | Bewertung | Änderung / Beobachtung |
| --- | --- | --- |
| Korrektheit | wichtige Fehler korrigiert | Original wurde bei Quellsprache ohne deutsche Ausgabe abgesenkt. Jetzt steuert gemessene Ausgabeaktivität den Mix. Lautstärke 0 lässt Original vollständig durch. |
| Lebenszyklus | verbessert | 15 s Finalisierungsfrist, sichtbare unvollständige Finalisierung, begrenzte HTTP-Requests, abbrechbarer Fetch, aufgeräumte Start-/Audio-Watchdogs, Behandlung unerwarteter session.closed. |
| Sicherheit | vorhandene Grenzen erhalten | API-Key nur serverseitig, konstante Tokenprüfung, strikteres Extension-Origin-Format, begrenzte Requests. Webseite kann Prompt und Stimme nicht überschreiben. |
| Leistung | kurze, begrenzte Signalwege | Direkter WebRTC-Track ohne zusätzliche STT/TTS-Stufe; AudioContext interactive; wiederverwendeter RMS-Samplepuffer; 25-ms-Mixkontrolle. Keine künstliche Videopufferung. |
| Wartbarkeit | gezielt modularisiert | Prompt/Stimme und reine Mix-/Aktivitätslogik ausgelagert und getestet. Dual-Untertitel können jetzt im laufenden Betrieb zugeschaltet werden. |

## Stimme und Prompt

Meridian (offiziell männliche Präsentation). Deutscher Prompt mit kurzem
Sinnabschnitt statt Satzende, ausschließlich Englisch→Deutsch, ohne
Begrüßung, Backchannels, Antworten, Websuche oder Wiederholung. Emotionen und
Countdowns sollen der Quelle folgen, nicht vorausgenommen werden.

## Nachweise und Grenzen

- Typecheck, Lint, 78 Tests und Bundle erfolgreich; Dependency-Audit: keine bekannten Schwachstellen.
- Chrome: neuen Build geladen, Sitzung auf dem öffentlichen SpaceX-Video gestartet.
- Tatsächlich dekodierter Ausgabepegel und 28-%-Mixzustand im Popup beobachtet.
- Kein gemessener Ende-zu-Ende-Latenzwert, keine vollständige Hör-/Sprachqualitätsabnahme.
- Englisch-only ist Modellverhalten, keine deterministische Sprachfilter-Garantie.
- Keine Quellentrennung: auch Atmo im Originalmix wird während des Dubbings abgesenkt.
- Alte PCM-/Envelope-Hilfen und zugehörige Tests bleiben als bestehende Infrastruktur erhalten; der aktive Dubbingpfad verwendet WebRTC und dubbing-mix.ts.

Quellen: https://developers.openai.com/api/docs/guides/live-prompting und
https://developers.openai.com/api/docs/guides/live-conversations
