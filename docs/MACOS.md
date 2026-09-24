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

- `ScreenCaptureKit` nimmt nur Audioausgaben entgegen, kein Video und kein Mikrofon.
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

Die App lässt den Originalton anderer Apps unverändert. Für einen ruhigeren
Mix kann deren Lautstärke in der jeweiligen App angepasst werden. Die
Chrome-Erweiterung besitzt zusätzlich einen eigenen Original-/Übersetzungsmix.

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

Das Buildskript erzeugt eine lokal ad-hoc-signierte App, keine notarisierte
öffentliche Distribution. Getestete Entwicklungsumgebung: macOS 27.0,
Xcode 27.0, Swift 6.4. Minimales Deployment-Ziel: macOS 14.
