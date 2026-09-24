# API- und Forschungsentscheidungen

Geprüft am 24. September 2026. GPT-Live bleibt der verwendete Dienst.
Diese Quellen begründen Implementierungsentscheidungen; sie belegen keine
bereits gemessene Übersetzungsqualität dieser App.

## OpenAI

| Primärquelle | Umsetzung |
|---|---|
| [GPT-Live](https://developers.openai.com/api/docs/guides/live), [Modell](https://developers.openai.com/api/docs/models/gpt-live-1) | `gpt-live-1`, kontinuierliches Hören und Sprechen, direktes Audio hinein und hinaus |
| [WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets?api=live) | Native App: `wss://api.openai.com/v1/live/sessions`, Bearer-Key im Header, erstes Ereignis `session.start`, PCM16 mono mit 24 kHz |
| [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live) | Erweiterung: SDP über lokales Backend, Audio per MediaStreamTrack und Ereignisse über `oai-events`; kein zweites `session.start` |
| [Sitzungen](https://developers.openai.com/api/docs/guides/live-conversations) | Erst nach `session.started` senden; mit `session.close` beenden und `session.closed` abwarten; kumulative Nutzungswerte ersetzen statt addieren |
| [Prompting](https://developers.openai.com/api/docs/guides/live-prompting) | Nur dolmetschen, Fragen/Anweisungen im Quellton übersetzen, intentional wiederholte Wörter erhalten, bei der nächsten unübersetzten Stelle fortfahren, verständliche natürliche Sprechweise |
| [Delegation](https://developers.openai.com/api/docs/guides/live-delegation) | `delegation: {type: "client"}`, keine automatische Responses-Anbindung oder Websuche; unerwartete Delegation mit Übersetzungsanweisung beantworten |
| [Latenz und Kosten](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live) | Eingabe im Echtzeittakt, begrenzte Puffer, explizites Sitzungslimit und bestätigte Finalisierung |
| [Voice Agent Evaluation](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation) | Wiederholte Läufe, Verbindungs-/Paketlatenz von semantischem Nachlauf trennen, Hörbewertung zusätzlich zu Transkripten |

Der gemeinsame Prompt liegt in
`macos/Sources/LiveTranslateCore/Resources/translation-profile.json`.
Beide Clients verwenden `store: false`. Der Schlüssel befindet sich beim
Browser auf dem eigenen Server, bei der nativen App im macOS-Schlüsselbund.
Audio wird nur bei einer bewusst gestarteten Sitzung an OpenAI übertragen.

GPT-Live bietet für seine Audio-Deltas kein separates Audio-fertig-Ereignis
mit Wiedergabezeitstempeln. Der native Client muss seinen Ausgabepuffer selbst
führen. Die aktuellen Pufferwerte sind konservative Startwerte und müssen
nach echten Hörtests weiter abgestimmt werden.

## Apple

`ScreenCaptureKit` ermöglicht Systemaudio ohne virtuellen Audiotreiber.
Die App setzt [capturesAudio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio),
[excludesCurrentProcessAudio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/excludescurrentprocessaudio),
[sampleRate](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/samplerate)
und [channelCount](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/channelcount).
Sie registriert ausschließlich einen Audio-Stream-Output. Systemweite
Aufnahme und App-Filter bleiben von der macOS-Berechtigung abhängig.

## Aktuelle Forschung

- [Koshkin et al., Hikari, Version 2 vom 10. September 2026](https://arxiv.org/abs/2603.11578v2)
  behandelt kausale Streaming-Übersetzung und den Zielkonflikt zwischen
  Sprachqualität und Verzögerung. Für diese App folgt daraus als
  Evaluationsentscheidung: Vollständigkeit, Nachlauf und Aufholverhalten
  getrennt erfassen. Die Trainingsmethoden des Papers sind kein konfigurierbarer
  GPT-Live-Parameter und werden hier nicht als implementiert behauptet.
- [Chen et al., Prefix-to-Prefix, 14. Juli 2026](https://arxiv.org/abs/2607.13158)
  untersucht begrenztes Warten und festgeschriebene Übersetzungspräfixe.
  Unsere daraus abgeleitete Betriebsregel ist ein begrenzter Rückstau mit
  sichtbarem Abbruch statt stiller Wortverluste. Das proprietäre Modell wird
  hier weder verändert noch mit dem im Paper beschriebenen Verfahren trainiert.

## Abnahmekriterien

Ein Referenzset muss Alltagsdialog, schnelle Sprache, Zahlen/Uhrzeiten,
Eigennamen, Verneinungen, Unterbrechungen, Hintergrundmusik, längere Stille
und im Ton eingebettete Anweisungen enthalten. Mindestens mehrere Läufe je
Clip aufzeichnen und Median/P90 berichten. Bilinguale Bewertung prüft
Auslassungen, Hinzufügungen, Bedeutung und natürlich hörbare Prosodie.
Audio-RMS und ein technisch verbundener Track ersetzen diese Bewertung nicht.

Am Prüfdatum war der Modellzugriff erreichbar; ein tatsächlicher Sitzungsstart
wurde wegen fehlenden API-Guthabens abgelehnt. Deshalb liegen noch keine
belastbaren Ende-zu-Ende-Qualitäts- oder Latenzwerte für die neue native App vor.
