import AppKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: SessionModel
    @State private var settingsVisible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                if settingsVisible {
                    Button { settingsVisible = false } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(.borderless).help("Zurück")
                }
                Text(settingsVisible ? "Einstellungen" : "Live Translate").font(.headline)
                Spacer()
                if !settingsVisible {
                    Button { settingsVisible = true } label: { Image(systemName: "gearshape") }
                        .buttonStyle(.borderless).help("Einstellungen")
                }
            }
            Divider()
            if settingsVisible {
                SettingsView(model: model)
            } else {
                controls
            }
            if let error = model.errorMessage {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                    Text(error).font(.caption).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    Button { model.errorMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless).help("Hinweis schließen")
                }
            }
            if let notice = model.notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Text(model.status).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Menu {
                    Button("Audioquelle lokal testen") { model.testCapture() }.disabled(model.isBusy)
                    Button("App-Liste aktualisieren") { model.refreshSources() }.disabled(model.isBusy)
                    Button("Transkript exportieren …") { model.exportTranscript() }.disabled(model.timeline.captions.isEmpty)
                    Menu("Verbindung") {
                        Text("Modell: GPT-Live")
                        Text("Eingang: \(Int(model.inputBufferMs)) ms")
                        Text("Ausgang: \(Int(model.outputBufferMs)) ms")
                        Text(model.roundTripMs.map { "Netzwerk: \(Int($0)) ms" } ?? "Netzwerk: —")
                        Text("API-Nutzung: \(Int(model.billedSeconds)) s")
                        Text(model.finalized ? "Sitzung bestätigt beendet" : "Keine Abschlussbestätigung")
                    }
                    Divider()
                    Button("Live Translate beenden") { NSApp.terminate(nil) }.keyboardShortcut("q")
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help("Weitere Optionen")
            }
        }
        .padding(14)
        .frame(width: 310)
        .controlSize(.small)
        .onAppear { model.refreshSources() }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("Audio").foregroundStyle(.secondary)
                    Picker("Audioquelle", selection: $model.selectedSource) {
                        Text("Gesamter Systemton").tag("system")
                        ForEach(model.sources) { source in Text(source.name).tag(source.id) }
                    }.labelsHidden().disabled(model.isBusy)
                }
                GridRow {
                    Text("Sprache").foregroundStyle(.secondary)
                    Picker("Quellsprache", selection: $model.englishOnly) {
                        Text("Englisch → Deutsch").tag(true)
                        Text("Automatisch → Deutsch").tag(false)
                    }.labelsHidden().disabled(model.isBusy)
                }
                GridRow {
                    Text("Stimme").foregroundStyle(.secondary)
                    Picker("Stimme", selection: $model.voice) {
                        ForEach(model.profile?.voices ?? [], id: \.self) { Text($0.capitalized).tag($0) }
                    }.labelsHidden().disabled(model.isBusy)
                }
            }
            HStack(spacing: 8) {
                Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                Slider(value: $model.volume, in: 0...1).accessibilityLabel("Lautstärke der Übersetzung")
                Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
            }
            Toggle("Schwebende Untertitel", isOn: $model.showOverlay)
            let caption = model.timeline.latest(.target)
            if !caption.isEmpty {
                Text(caption).font(.callout).lineLimit(3).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                if model.isBusy { Task { await model.stop() } }
                else if !model.hasKey { settingsVisible = true }
                else { model.start() }
            } label: {
                Text(model.isBusy ? "Stoppen" : model.hasKey ? "Übersetzen" : "API-Key einrichten …")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.regular)
            .disabled(model.phase == .stopping)
            .keyboardShortcut("t", modifiers: [.command, .shift])
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var model: SessionModel
    @State private var key = ""
    @State private var keyError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.hasKey ? "API-Key im Schlüsselbund gespeichert" : "OpenAI API-Key").font(.subheadline)
            SecureField(model.hasKey ? "API-Key ersetzen" : "sk-…", text: $key).textFieldStyle(.roundedBorder)
            HStack {
                Button("Importieren …") { model.importKey() }
                Spacer()
                Button("Speichern") {
                    do { try model.saveKey(key); key = ""; keyError = nil }
                    catch { keyError = error.localizedDescription }
                }.disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let keyError { Text(keyError).font(.caption).foregroundStyle(.orange) }
            Text("Audio wird beim Übersetzen an OpenAI gesendet. Die API wird separat vom ChatGPT-Abo abgerechnet.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Link("API-Guthaben verwalten", destination: URL(string: "https://platform.openai.com/settings/organization/billing/overview")!)
                .font(.caption)
            Divider()
            Picker("Sitzungslimit", selection: $model.maxMinutes) {
                Text("15 Minuten").tag(15); Text("30 Minuten").tag(30)
                Text("60 Minuten").tag(60); Text("120 Minuten").tag(120)
            }.disabled(model.isBusy)
            Button("Systemaudio-Berechtigung öffnen …") {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
            }
        }
    }
}
