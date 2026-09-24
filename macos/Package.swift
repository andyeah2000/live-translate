// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LiveTranslate",
    platforms: [.macOS("14.4")],
    products: [
        .executable(name: "LiveTranslate", targets: ["LiveTranslate"]),
        .executable(name: "LiveTranslateProbe", targets: ["LiveTranslateProbe"])
    ],
    dependencies: [
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager", exact: "1.24.2")
    ],
    targets: [
        .target(name: "LiveTranslateCore", resources: [.process("Resources")]),
        .target(name: "LiveTranslateAudio", dependencies: ["LiveTranslateCore",
            .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager")]),
        .executableTarget(name: "LiveTranslate", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"]),
        .executableTarget(name: "LiveTranslateProbe", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"]),
        .testTarget(name: "LiveTranslateCoreTests", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"])
    ],
    swiftLanguageModes: [.v6]
)
