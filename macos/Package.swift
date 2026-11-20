// swift-tools-version: 6.0
import PackageDescription

let onnxRuntimeLink: [LinkerSetting] = [
    .unsafeFlags([
        "-F", Context.packageDirectory + "/Vendor/onnxruntime.xcframework/macos-arm64_x86_64",
        "-framework", "onnxruntime"
    ])
]

let package = Package(
    name: "LiveTranslate",
    platforms: [.macOS("14.4")],
    products: [
        .executable(name: "LiveTranslate", targets: ["LiveTranslate"]),
        .executable(name: "LiveTranslateProbe", targets: ["LiveTranslateProbe"])
    ],
    targets: [
        .binaryTarget(name: "onnxruntime", path: "Vendor/onnxruntime.xcframework"),
        .target(
            name: "OnnxRuntimeBindings",
            dependencies: ["onnxruntime"],
            path: "Vendor/OnnxRuntimeBindings",
            publicHeadersPath: "include",
            cSettings: [.headerSearchPath("capi")],
            cxxSettings: [
                .headerSearchPath("capi"),
                .unsafeFlags(["-std=c++17", "-fobjc-arc-exceptions"])
            ],
            linkerSettings: onnxRuntimeLink + [
                .linkedFramework("CoreML"),
                .linkedFramework("CoreFoundation"),
                .linkedFramework("Foundation"),
                .linkedFramework("IOKit"),
                .linkedFramework("Network"),
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration"),
                .linkedLibrary("c++")
            ]
        ),
        .target(name: "LiveTranslateCore", resources: [.process("Resources")]),
        .target(name: "LiveTranslateAudio", dependencies: ["LiveTranslateCore", "OnnxRuntimeBindings"]),
        .executableTarget(name: "LiveTranslate", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"], linkerSettings: onnxRuntimeLink),
        .executableTarget(name: "LiveTranslateProbe", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"], linkerSettings: onnxRuntimeLink),
        .testTarget(name: "LiveTranslateCoreTests", dependencies: ["LiveTranslateCore", "LiveTranslateAudio"], linkerSettings: onnxRuntimeLink)
    ],
    swiftLanguageModes: [.v6]
)
