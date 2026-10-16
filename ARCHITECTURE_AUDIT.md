# Architekturprüfung · 16. Oktober 2026

## Ergebnis

Die vorhandene Architektur ist für kontinuierliches Dolmetschen in Chrome
geeignet. Die zweite Prüfung hat zusätzliche Fehler an den Übergängen zwischen
Tab, Service Worker, Offscreen-Dokument und Provider gefunden und in Version
3.0.2 behoben. Ein vollständiger Neuaufbau hätte diese Laufzeitgrenzen nicht
beseitigt. Der Schwerpunkt liegt deshalb auf begrenzten Wartezeiten, eindeutigem
Sitzungsbesitz und nachgewiesener Audioausgabe.

## Verantwortlichkeiten

| Bereich | Aufgabe und Grenze |
| --- | --- |
| Popup | Einstellungen und Bedienung; Sperren während ausstehender Einstellungsübernahme, sichtbare lokale Fehler. |
| Service Worker | Serialisiert Sitzungswechsel; verwirft alte Sitzungsereignisse und begrenzt Nachrichten an nicht reagierende Tabs. |
| Content Script | Untertitel und direkte Medienaufnahme; besitzt keine OpenAI-Zugangsdaten. |
| Offscreen-Dokument | AudioContext, Original-/Zieltonmischung und WebRTC-Lebensdauer unabhängig vom kurzlebigen Popup. |
| Lokaler Server | Prüft Zugriffstoken, Origin, SDP und Antwortgröße; hält den OpenAI-Key ausschließlich serverseitig. |
| GPT-Live | Durchgehender Audioeingang und deutsche Sprachausgabe; Quellbefehle werden als zu übersetzender Inhalt behandelt. |

Die direkte Medienaufnahme hält den Provider-Eingang unabhängig von
Player-Stummschaltung und Lautstärke. Wo sie nicht verfügbar ist, verwendet das
Add-on Tab-Aufnahme; dort beeinflusst die Lautstärke des Players den Eingang.
Die Spracherkennung für den Mix regelt den Originalton, sie schneidet keine
Quellsprache aus dem Provider-Eingang heraus.

## Zusätzliche Reparaturen in 3.0.2

- Ein nicht reagierender Tab konnte Stop über Untertitel- oder
  Aufräumnachrichten blockieren. Diese Nachrichten haben jetzt eine Deadline;
  Aufräumen der Medienaufnahme ist an die konkrete Sitzung gebunden.
- Ein Wechsel der Medienquelle konnte die direkte Aufnahme unnötig beenden.
  Ersatz-Audiospuren werden innerhalb eines begrenzten Zeitfensters mit
  `RTCRtpSender.replaceTrack` in die bestehende Verbindung übernommen.
  Fehlende oder fehlgeschlagene Ersatzspuren führen weiterhin zum Abbruch.
- Frühes `session.closed`, unmittelbar auf Bereitschaft folgende Fehler und
  synchroner Abbruch aus einem Bereitschafts-Callback konnten Start hängen
  lassen oder einen bereits beendeten Start als erfolgreich darstellen.
- Eine beendete Ziel-Audiospur konnte eine stumme Sitzung mit weiterlaufendem
  Eingang hinterlassen. Ein unerwartetes Ende beendet jetzt den Transport.
- Native Vollbild-Untertitel berücksichtigen Wiedergabegeschwindigkeit und
  Änderungen der Medienzeit. Offene Shadow Roots werden bei der Platzierung
  berücksichtigt; Navigation räumt die Anzeige auf.
- Telemetrie konnte sichtbare Popup-Fehler überschreiben. Außerdem konnten
  Ausgabeänderungen mit einer ausstehenden Start-/Stimmenkonfiguration
  konkurrieren. Beide Fälle sind jetzt abgesichert.

## Nachweise und Grenzen

Der abschließende Lauf mit Node 24.22.0 besteht TypeScript, ESLint, 174 Tests,
Coverage-Grenzen, MV3-Build und Abhängigkeitsprüfung. Die geprüften Quelldateien
wurden vor der Übernahme des Builds über SHA-256 mit dem Arbeitsverzeichnis
verglichen. Die drei Prüflinien besitzen getrennte Dateien; der Transportprüfer
hat zusätzlich die Lebenszyklusänderungen unabhängig gegengelesen.

Ein echter `gpt-live-1`-Test über den nativen WebSocket-Client lieferte für
16,38 Sekunden synthetisches Englisch deutsche Transkripte und nicht stille
Audioausgabe. Zahlen, Verneinung und Frage blieben erhalten. Verbindungsaufbau:
1,87 Sekunden; erste nicht stille Ausgabe nach Eingang: 3,02 Sekunden;
`session.closed` bestätigt. Das ist keine Messung semantischer Verzögerung oder
der allgemeinen Modellqualität und kein Ersatz für die Chrome-Abnahme.

Im echten Chrome-Add-on 3.0.1 wurden deutsche YouTube-Untertitel und gemessene
deutsche Audioausgabe sichtbar bestätigt. Ziel-Lautstärke 0 setzte den
angezeigten Originalton auf 100 Prozent zurück. Die Live-Ergebnisse werden in
`VERIFICATION.md` fortgeschrieben und nicht ungeprüft auf spätere Builds
übertragen.

Offen bleiben eine längere Betrachtung mit verschiedenen Netzbedingungen,
eine bilinguale Hörbewertung und native Vollbild-Untertitel in fremden
Cross-Origin-Iframes. Top-Level-YouTube ist von der letzten Grenze nicht
betroffen. Unbekannte Fehler und perfekte Übersetzungsqualität sind durch
automatisierte Tests nicht ausgeschlossen.
