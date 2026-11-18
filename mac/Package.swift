// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PDFStudio",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "PDFStudio",
            path: "Sources/PDFStudio",
            resources: [.copy("Resources/i18n")],
            linkerSettings: [
                .linkedFramework("PDFKit"),
                .linkedFramework("Vision"),
                .linkedFramework("Quartz")
            ]
        )
    ]
)
