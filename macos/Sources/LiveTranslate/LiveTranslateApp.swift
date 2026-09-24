import AppKit
import Combine
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var observation: AnyCancellable?
    private var outsideClickMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "translate", accessibilityDescription: "Live Translate")
        item.button?.setAccessibilityLabel("Live Translate")
        item.button?.toolTip = "Live Translate"
        item.button?.target = self
        item.button?.action = #selector(togglePopup)
        statusItem = item

        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 310, height: 280),
                            styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = "Live Translate"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isReleasedWhenClosed = false
        panel.isMovable = false
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = ContentView(model: .shared)
            .fixedSize(horizontal: false, vertical: true)
            .background(.regularMaterial)
            .ignoresSafeArea()
            .onExitCommand { [weak self] in self?.panel?.orderOut(nil) }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { [weak self] size in
                self?.panel?.setContentSize(size)
                self?.positionPopup()
            }
        panel.contentViewController = NSHostingController(rootView: view)
        self.panel = panel
        observation = SessionModel.shared.$phase.sink { [weak self] phase in
            self?.statusItem?.button?.image = NSImage(
                systemSymbolName: phase == .running ? "waveform" : "translate",
                accessibilityDescription: "Live Translate")
        }
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.panel?.orderOut(nil)
        }
        showPopup()
    }

    @objc private func togglePopup() {
        if panel?.isVisible == true { panel?.orderOut(nil) } else { showPopup() }
    }

    private func positionPopup() {
        guard let panel, let button = statusItem?.button,
              let screen = button.window?.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        let anchor = button.window?.convertToScreen(button.convert(button.bounds, to: nil))
        let x = min(max((anchor?.midX ?? visible.maxX) - panel.frame.width / 2, visible.minX + 8), visible.maxX - panel.frame.width - 8)
        let y = min(anchor?.minY ?? visible.maxY, visible.maxY) - panel.frame.height - 6
        panel.setFrameOrigin(NSPoint(x: x, y: max(visible.minY + 8, y)))
    }

    private func showPopup() {
        positionPopup()
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPopup()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard SessionModel.shared.isBusy else { return .terminateNow }
        Task { await SessionModel.shared.stop(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

@main
struct LiveTranslateApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
