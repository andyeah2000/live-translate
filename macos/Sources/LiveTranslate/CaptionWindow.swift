import AppKit
import SwiftUI

@MainActor
final class CaptionWindow {
    private var panel: NSPanel?
    func setVisible(_ visible: Bool, model: SessionModel) {
        if !visible { panel?.orderOut(nil); return }
        if panel == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 740, height: 145),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.isOpaque = false; panel.backgroundColor = .clear
            panel.hasShadow = true; panel.isMovableByWindowBackground = true
            panel.hidesOnDeactivate = false
            panel.contentView = NSHostingView(rootView: FloatingCaption(model: model))
            if let screen = NSScreen.main {
                panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 370, y: screen.visibleFrame.minY + 55))
            }
            self.panel = panel
        }
        panel?.orderFrontRegardless()
    }
}

private struct FloatingCaption: View {
    @ObservedObject var model: SessionModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: "waveform").foregroundStyle(.secondary)
                Text(model.status).font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Button { model.showOverlay = false } label: { Image(systemName: "xmark") }.buttonStyle(.plain)
            }
            Text(model.timeline.latest(.target).isEmpty ? "Die Übersetzung erscheint hier." : model.timeline.latest(.target))
                .font(.system(size: 23, weight: .medium)).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
        }.padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}
