# macOS-App

## Einrichten

1. `npm run macos:build` ausführen und `macos/build/Live Translate.app` öffnen.
   Für einen festen Installationsort die App vorher in den Programme-Ordner kopieren.
2. Im kleinen Menüleisten-Pop-up das Zahnrad öffnen. Einen eigenen OpenAI-
   Projektschlüssel eintragen oder eine lokale `.env`-Datei importieren.
   Der Schlüssel liegt danach im macOS-Schlüsselbund, nicht in Einstellungen
   oder Protokolldateien. Das ChatGPT-Abonnement enthält kein API-Guthaben.
3. Die Systemaudio-Berechtigung in den macOS-Datenschutzeinstellungen erlauben.
   macOS führt diese Berechtigung je nach Version mit Bildschirmaufnahme zusammen.
4. Eine laufende App oder den gesamten Systemton auswählen. Quellton starten
   und „Übersetzen“ anklicken. Das Menüleistensymbol öffnet/schließt das Pop-up.

Die App hat kein Hauptfenster und erscheint nicht im Dock. Sie übernimmt die
macOS-Darstellung einschließlich Hell/Dunkel. Das optionale Untertitelfenster
ist verschiebbar und bleibt auch neben einer App im Vollbild sichtbar.

Unter „Weitere Optionen“ lässt sich die Audioquelle zehn Sekunden lokal
prüfen. Dieser Test sendet nichts an OpenAI und speichert keine Aufnahme.
„Transkript exportieren“ speichert nur nach Auswahl eines Dateipfads die
aktuell im Arbeitsspeicher gehaltenen Untertitel; der Verlauf ist auf 200
Segmente begrenzt.

## Audio und Verbindung

- Ein privater Core-Audio-Prozess-Tap nimmt Systemton oder eine gewählte App
  auf, ohne Bildschirm- oder Mikrofonaufnahme. Ab macOS 14.4 verfügbar.
- Der Originalton wird während der Aufnahme ausschließlich über den lokalen
  Stereomix wiedergegeben. „Original“ und „Deutsch“ haben unabhängige Regler
  und Stummschalter. Die Einstellungen werden gespeichert; Stummschaltung
  wird beim nächsten App-Start zurückgesetzt.
- „Neuronales Auto-Dubbing“ ist standardmäßig eingeschaltet. Dasselbe Silero-
  VAD-6.2.1-Modell wie im Addon läuft lokal mit ONNX Runtime. Es erkennt
  Quellsprache; der Mix senkt diese während tatsächlich hörbarer deutscher
  Ausgabe auf 28 % und Atmosphäre auf 60 %. 220 ms Haltezeit verbindet Silben.
  Der Sprachpegel ist einstellbar. Die Original-Lautstärke multipliziert diese
  Werte. Bei stummer Übersetzung findet keine automatische Absenkung statt.
- Weiche Pegelrampen vermeiden abruptes Ein-/Ausschalten. Stoppen, Fehler und
  Prozessende geben den normalen Originalton wieder frei. Ein Wechsel des
  Ausgabegeräts stoppt die Sitzung und verlangt einen manuellen Neustart.
- Die API erhält immer ungedämpftes Audio; der lokale Mix entfernt keine Wörter.
  Silero trennt keine Stimmen von Musik und identifiziert keine Sprache.
- Die App schließt ihre eigene Sprachausgabe vom Eingang aus. Beim Betrieb
  mit weiteren Übersetzern muss deren Wiedergabe separat ausgeschlossen werden.
- GPT-Live bekommt PCM16, 24 kHz, mono, in fortlaufenden 20-ms-Blöcken.
  Auch Stille wird im Takt weitergeschickt. Es gibt keine VAD, die Wörter
  vor der API abschneiden kann.
- Die deutsche Ausgabe verwendet `AVAudioEngine`. Ein 60-ms-Startpuffer
  gleicht kleine Unregelmäßigkeiten aus. Bei Rückstau wird die Wiedergabe
  mit unveränderter Tonhöhe moderat bis auf 1,12× beschleunigt.
- Mehr als 500 ms Eingangspuffer oder acht Sekunden Ausgaberückstau stoppen
  die Sitzung sichtbar. Es werden keine Wörter stillschweigend gelöscht.
- „Stoppen“ wartet auf `session.closed` und lässt bereits erhaltenes Audio
  auslaufen. Ein Timeout wird als unbestätigter Abschluss gemeldet.
- Ein einstellbares Sitzungslimit und der Ruhezustand beenden die Verbindung.
  Es gibt keinen unbeaufsichtigten kostenpflichtigen Wiederverbindungsversuch.

Der lokale Audiotest verwendet denselben Aufnahme- und Originalmix ohne
API-Verbindung. So lässt sich der Originalregler vor einer bezahlten Sitzung
prüfen. Die normale Audioausgabe kehrt nach zehn Sekunden zurück.
Das kompakte Pop-up enthält keine schnell wechselnden Sprach-/Hör-Indikatoren.

## Entwicklung und Prüfung

```bash
swift test --package-path macos
npm run macos:build
swift run --package-path macos LiveTranslateProbe --audio-self-test
```

Der letzte Befehl spielt einen kurzen leisen Testton über den tatsächlichen
macOS-Ausgabepfad. Für eine echte API-Prüfung mit einer eigenen, freigegebenen
Sprachdatei wird der Schlüssel ausschließlich aus `OPENAI_API_KEY` gelesen:

```bash
swift run --package-path macos LiveTranslateProbe --live-test \
  --file /path/to/source.aiff --output /path/to/translation.wav \
  --report /path/to/metrics.json
```

Dieser API-Test ist kostenpflichtig. Er prüft Ausgabeaudio, Transkripte und
bestätigten Abschluss. Die Zeit bis zum ersten Audiopaket ist keine Messung
der semantischen Übersetzungsverzögerung. Dafür braucht es Satz- oder
Wortalignment und menschliche Bewertung; siehe [Verifikation](../VERIFICATION.md).

Das Buildskript verwendet ein vorhandenes Developer-ID- oder Apple-Development-
Zertifikat aus dem Schlüsselbund. Bei mehreren Zertifikaten muss
`LIVE_TRANSLATE_SIGN_IDENTITY` ausdrücklich ausgewählt werden. Ein fehlendes
Zertifikat führt zum Abbruch statt zu einer instabilen Ad-hoc-Signatur.
Nur für CI ist `LIVE_TRANSLATE_SIGN_IDENTITY=-` vorgesehen. Die App ist dadurch
nicht automatisch notarisiert. Getestete Entwicklungsumgebung: macOS 27.0,
Xcode 27.0, Swift 6.4. Minimales Deployment-Ziel: macOS 14.4.

## Freigabe eingeschaltet, Aufnahme trotzdem abgelehnt

Frühere Ad-hoc-Builds wurden anhand ihres wechselnden Code-Hashes freigegeben.
Ein neuer Build konnte deshalb trotz eingeschaltetem Schalter abgewiesen werden.
Das macOS-TCC-Protokoll meldet dann `Failed to match existing code requirement`.
Ein Neustart des Computers repariert diese abweichende Signatur nicht.

Nach dem einmaligen Wechsel auf das feste Apple-Zertifikat die App beenden,
den veralteten Eintrag ausschließlich für Live Translate zurücksetzen und
die neu signierte App am festen Installationsort erneut freigeben. Der offizielle
gezielte Reset lautet `tccutil reset ScreenCapture org.andyeah.live-translate`.
Er erteilt selbst keine Freigabe; die Zustimmung erfolgt anschließend in macOS.
Zukünftige Builds müssen dasselbe Zertifikat und dieselbe Bundle-ID verwenden.
Siehe [Apple zur Signaturursache](https://developer.apple.com/forums/thread/819406).

Technische Grundlage: [Apple Core Audio Taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
und [Mute-Verhalten](https://developer.apple.com/documentation/coreaudio/catapmutebehavior).
Die App verwendet `mutedWhenTapped`, damit das Original nur während aktiver
Aufnahme umgeleitet wird. Die API-Aufnahmefreigabe bleibt eine macOS-Entscheidung.
