//! Plum's environments and their addresses (the TS SDK's `env.ts`).
//!
//! Production is the default everywhere. Staging (`staging.plumbox.me`) is
//! Plum's own test environment. Each environment accepts only its own
//! addresses: a production client never takes a staging box, and a staging
//! client never takes a production one.

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// A Plum environment: where boxes live (`https://pb-<name>.<box_domain>`),
/// the portal where people find their box, and the relay.
///
/// [`Environment::Production`] is the default. Pick
/// [`Environment::Staging`] only for Plum's own staging boxes, or by box
/// domain with [`Environment::from_box_domain`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Environment {
    /// `plumbox.me`: every real user's box.
    #[default]
    Production,
    /// `staging.plumbox.me`: Plum's own test environment.
    Staging,
    /// A fake box on a loopback address, such as the one
    /// [`testing::FakeBox`](crate::testing::FakeBox) runs. `origin` is that
    /// box's exact origin (`http://127.0.0.1:<port>`); it is the only issuer
    /// this environment accepts, and also its portal.
    ///
    /// Exists only with the `testing` feature, which a product build must
    /// never enable.
    #[cfg(feature = "testing")]
    Local {
        /// The fake box's origin, e.g. `http://127.0.0.1:49152`.
        origin: String,
    },
}

const PRODUCTION_BOX_DOMAIN: &str = "plumbox.me";
const STAGING_BOX_DOMAIN: &str = "staging.plumbox.me";

impl Environment {
    /// The environment whose box domain is `box_domain` (case-insensitive),
    /// like the TS `plumEnvironment()`. An empty string is production.
    /// Anything else is [`Error::InvalidInput`]: there is no third
    /// environment, and a typo must not quietly become one.
    pub fn from_box_domain(box_domain: &str) -> Result<Self> {
        if box_domain.is_empty() {
            return Ok(Self::Production);
        }
        match box_domain.to_ascii_lowercase().as_str() {
            PRODUCTION_BOX_DOMAIN => Ok(Self::Production),
            STAGING_BOX_DOMAIN => Ok(Self::Staging),
            _ => Err(Error::InvalidInput(format!(
                "unknown Plum box domain \"{box_domain}\" (only plumbox.me and staging.plumbox.me exist)"
            ))),
        }
    }

    /// `"production"`, `"staging"` (or `"local"` for the testing environment).
    pub fn name(&self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Staging => "staging",
            #[cfg(feature = "testing")]
            Self::Local { .. } => "local",
        }
    }

    /// A box is `https://pb-<name>.<box_domain>`: `plumbox.me` or
    /// `staging.plumbox.me` (for `Local`, the fake box's origin).
    pub fn box_domain(&self) -> &str {
        match self {
            Self::Production => PRODUCTION_BOX_DOMAIN,
            Self::Staging => STAGING_BOX_DOMAIN,
            #[cfg(feature = "testing")]
            Self::Local { origin } => origin,
        }
    }

    /// Where people find their box and the authorization starts.
    pub fn portal_origin(&self) -> &str {
        match self {
            Self::Production => "https://plumbox.me",
            Self::Staging => "https://staging.plumbox.me",
            #[cfg(feature = "testing")]
            Self::Local { origin } => origin,
        }
    }

    /// The relay.
    pub fn relay_url(&self) -> &str {
        match self {
            Self::Production => "https://relay.plumbox.me",
            Self::Staging => "https://relay.staging.plumbox.me",
            #[cfg(feature = "testing")]
            Self::Local { origin } => origin,
        }
    }
}

/// The real environment whose box domain `host` lies in, the most specific one.
fn environment_of_host(host: &str) -> Option<Environment> {
    let h = host.to_ascii_lowercase();
    let h = h.strip_suffix('.').unwrap_or(&h);
    let within = |domain: &str| h == domain || h.ends_with(&format!(".{domain}"));
    // Staging's domain lies inside production's: test it first.
    if within(STAGING_BOX_DOMAIN) {
        Some(Environment::Staging)
    } else if within(PRODUCTION_BOX_DOMAIN) {
        Some(Environment::Production)
    } else {
        None
    }
}

/// Whether `url` is an address of another environment than `env`: its host
/// lies in another environment's box domain. An address of no environment (a
/// LAN IP, localhost, a test server) is not foreign; neither is one that
/// cannot be read.
pub fn is_foreign_url(url: &str, env: &Environment) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    match environment_of_host(host) {
        Some(owner) => owner.name() != env.name(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROD_BOX: &str = "https://pb-0123456789abcdef0123456789abcdef.plumbox.me";
    const STAG_BOX: &str = "https://pb-0123456789abcdef0123456789abcdef.staging.plumbox.me";

    #[test]
    fn production_values_are_what_the_sdk_always_used() {
        let p = Environment::Production;
        assert_eq!(p.name(), "production");
        assert_eq!(p.box_domain(), "plumbox.me");
        assert_eq!(p.portal_origin(), "https://plumbox.me");
        assert_eq!(p.relay_url(), "https://relay.plumbox.me");
        let s = Environment::Staging;
        assert_eq!(s.box_domain(), "staging.plumbox.me");
        assert_eq!(s.portal_origin(), "https://staging.plumbox.me");
        assert_eq!(s.relay_url(), "https://relay.staging.plumbox.me");
        assert_eq!(Environment::default(), Environment::Production);
    }

    #[test]
    fn only_two_environments_exist() {
        assert_eq!(
            Environment::from_box_domain("").unwrap(),
            Environment::Production
        );
        assert_eq!(
            Environment::from_box_domain("plumbox.me").unwrap(),
            Environment::Production
        );
        assert_eq!(
            Environment::from_box_domain("STAGING.plumbox.me").unwrap(),
            Environment::Staging
        );
        for bad in [
            "dev.plumbox.me",
            ".plumbox.me",
            "plumbox.me.",
            "example.com",
            "staging",
        ] {
            assert!(
                matches!(
                    Environment::from_box_domain(bad),
                    Err(Error::InvalidInput(_))
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn foreign_urls() {
        let (prod, stag) = (Environment::Production, Environment::Staging);
        assert!(is_foreign_url(STAG_BOX, &prod));
        assert!(is_foreign_url("https://relay.staging.plumbox.me", &prod));
        assert!(!is_foreign_url(PROD_BOX, &prod));
        assert!(is_foreign_url(PROD_BOX, &stag));
        assert!(is_foreign_url("https://plumbox.me", &stag));
        assert!(!is_foreign_url(STAG_BOX, &stag));
        for env in [&prod, &stag] {
            assert!(!is_foreign_url("http://192.168.0.10:8443", env));
            assert!(!is_foreign_url("http://127.0.0.1:8080", env));
            assert!(!is_foreign_url("https://evilplumbox.me", env));
            assert!(!is_foreign_url("not a url", env));
        }
    }
}
