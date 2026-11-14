import Foundation

/// The one place in `PlumBoxClient` that knows Plum's environments and their
/// addresses: the box domain (a box is `https://pb-<name>.<boxDomain>`), the
/// portal where people find their box, and the relay.
///
/// Production is the default everywhere. Staging (`staging.plumbox.me`) is for
/// Plum's own test environment; an app chooses it with
/// `environment: .staging`. Each environment accepts only its own addresses: a
/// production client never takes a staging box, and a staging client never
/// takes a production one.
///
/// There is no third environment, and there is no public initializer: a typo
/// must not quietly become one. (`@plumbox/client`: `PRODUCTION`, `STAGING`,
/// `plumEnvironment()`.)
public struct PlumEnvironment: Sendable, Hashable, CustomStringConvertible {
    public enum Name: String, Sendable, Hashable {
        case production
        case staging
    }

    public let name: Name
    /// A box is `https://pb-<name>.<boxDomain>`.
    public let boxDomain: String
    /// Where people find their box and the authorization starts.
    public let portalOrigin: String
    /// The relay.
    public let relayUrl: String

    public static let production = PlumEnvironment(
        name: .production,
        boxDomain: "plumbox.me",
        portalOrigin: "https://plumbox.me",
        relayUrl: "https://relay.plumbox.me"
    )

    public static let staging = PlumEnvironment(
        name: .staging,
        boxDomain: "staging.plumbox.me",
        portalOrigin: "https://staging.plumbox.me",
        relayUrl: "https://relay.staging.plumbox.me"
    )

    static let all: [PlumEnvironment] = [.production, .staging]

    private init(name: Name, boxDomain: String, portalOrigin: String, relayUrl: String) {
        self.name = name
        self.boxDomain = boxDomain
        self.portalOrigin = portalOrigin
        self.relayUrl = relayUrl
    }

    /// The environment whose box domain is `boxDomain` (case-insensitive). No
    /// value (nil or "") is production. Anything else throws
    /// ``PlumUsageError``: only `plumbox.me` and `staging.plumbox.me` exist.
    public init(boxDomain: String?) throws {
        guard let boxDomain, !boxDomain.isEmpty else {
            self = .production
            return
        }
        let want = boxDomain.lowercased()
        guard let found = PlumEnvironment.all.first(where: { $0.boxDomain == want }) else {
            throw PlumUsageError(
                "unknown Plum box domain \"\(boxDomain)\" (only plumbox.me and staging.plumbox.me exist)"
            )
        }
        self = found
    }

    public var description: String { boxDomain }
}

/// The environment whose box domain is `boxDomain` — `@plumbox/client`'s
/// `plumEnvironment()`. Same as ``PlumEnvironment/init(boxDomain:)``.
public func plumEnvironment(_ boxDomain: String? = nil) throws -> PlumEnvironment {
    try PlumEnvironment(boxDomain: boxDomain)
}

/// The environment whose box domain `host` lies in — the most specific one.
private func environmentOfHost(_ host: String) -> PlumEnvironment? {
    var h = host.lowercased()
    if h.hasSuffix(".") { h.removeLast() }
    var best: PlumEnvironment?
    for e in PlumEnvironment.all where h == e.boxDomain || h.hasSuffix("." + e.boxDomain) {
        if best == nil || e.boxDomain.count > best!.boxDomain.count { best = e }
    }
    return best
}

/// Whether `url` is an address of another environment than `env`: its host
/// lies in another environment's box domain. An address of no environment (a
/// LAN IP, localhost, a test server) is not foreign; neither is one that
/// cannot be read.
public func isForeignUrl(_ url: String, _ env: PlumEnvironment) -> Bool {
    guard let host = URLComponents(string: url)?.host, !host.isEmpty else { return false }
    guard let owner = environmentOfHost(host) else { return false }
    return owner.name != env.name
}
