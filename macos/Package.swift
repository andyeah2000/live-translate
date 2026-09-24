// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LiveTranslate",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "LiveTranslate", targets: ["LiveTranslate"]),
        .executable(name: "LiveTranslateProbe", targets: ["LiveTranslateProbe"])
    ],
    targets: [
        .target(name: "LiveTranslateCore", resources: [.process("Resources")]),
        .target(name: "LiveTranslateAudio", dependencies: ["LiveTranslateCore"]),
        .executableTarget(name: "LiveTranslate", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"]),
        .executableTarget(name: "LiveTranslateProbe", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"]),
        .testTarget(name: "LiveTranslateCoreTests", dependencies: ["LiveTranslateCore"])
    ],
    swiftLanguageModes: [.v6]
)
