// swift-tools-version:6.0
//
// PlumBox client for Swift — the Swift counterpart of `@plumbox/client`
// (packages/client). The sources live under swift/; this manifest sits at the
// repository root only because SwiftPM needs it there for a git-URL
// dependency:
//
//     .package(url: "https://github.com/plum-networks/plum-sdk", from: "…")
//     .product(name: "PlumBoxClient", package: "plum-sdk")
//
// No third-party dependencies: Foundation (URLSession), CryptoKit (SHA-256),
// Security (random bytes, Keychain), AuthenticationServices (system browser).
import PackageDescription

let package = Package(
    name: "plum-sdk",
    platforms: [
        // URLSession's async API and a clean async/await story start here;
        // ASWebAuthenticationSession and CryptoKit are older than this.
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "PlumBoxClient", targets: ["PlumBoxClient"]),
    ],
    targets: [
        .target(
            name: "PlumBoxClient",
            path: "swift/Sources/PlumBoxClient"
        ),
        .testTarget(
            name: "PlumBoxClientTests",
            dependencies: ["PlumBoxClient"],
            path: "swift/Tests/PlumBoxClientTests",
            // The fake box is a URLProtocol subclass driven from several
            // tasks; the library itself is built in Swift 6 mode.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
