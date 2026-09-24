import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for (name, pixels) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
                       ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
                       ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    let image = NSImage(size: NSSize(width: pixels, height: pixels))
    image.lockFocus()
    let scale = CGFloat(pixels) / 1024
    let transform = NSAffineTransform(); transform.scale(by: scale); transform.concat()
    let background = NSBezierPath(roundedRect: NSRect(x: 50, y: 50, width: 924, height: 924), xRadius: 210, yRadius: 210)
    NSGradient(starting: NSColor(red: 0.12, green: 0.17, blue: 0.18, alpha: 1),
               ending: NSColor(red: 0.035, green: 0.055, blue: 0.065, alpha: 1))!.draw(in: background, angle: -45)
    let heights: [CGFloat] = [100, 260, 420, 560, 420, 260, 100]
    for (index, height) in heights.enumerated() {
        NSColor(red: 0.49, green: 0.91, blue: 0.76, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 214 + CGFloat(index) * 90, y: 512 - height / 2, width: 56, height: height),
                     xRadius: 28, yRadius: 28).fill()
    }
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name + ".png"))
}
