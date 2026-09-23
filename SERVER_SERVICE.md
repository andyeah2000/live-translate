# Automatischer Server auf diesem Mac

Der Server läuft als Benutzer-LaunchAgent `com.andreas.live-translate`.
Er startet bei Anmeldung und wird nach Prozessende automatisch neu gestartet.
Codex und Terminal müssen nicht geöffnet bleiben. Im Ruhezustand arbeitet
der Mac nicht weiter; nach dem Aufwachen kann eine neue Übersetzungssitzung nötig sein.

- Dienstdatei: `/Users/andreastumbrink/Library/LaunchAgents/com.andreas.live-translate.plist`
- Schlüssel: `.env.local` (nur für den Benutzer lesbar; nicht im Dienst hinterlegt)
- Bindung: ausschließlich `127.0.0.1:8787`
- Logs: `/Users/andreastumbrink/Library/Logs/LiveTranslate/`

Status: `launchctl print gui/501/com.andreas.live-translate`

Neuen Key oder Servercode laden:
`launchctl kickstart -k gui/501/com.andreas.live-translate`

Dienst deaktivieren:
`launchctl bootout gui/501 /Users/andreastumbrink/Library/LaunchAgents/com.andreas.live-translate.plist`

Erneut aktivieren:
`launchctl bootstrap gui/501 /Users/andreastumbrink/Library/LaunchAgents/com.andreas.live-translate.plist`

Nicht gleichzeitig `npm run server` starten: Port 8787 gehört dem Hintergrunddienst.
Nach einem Verschieben des Projekts oder Entfernen von Homebrew Node müssen
die absoluten Pfade in der Dienstdatei angepasst werden.
