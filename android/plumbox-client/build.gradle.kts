// :plumbox-client — the PlumBox client for Android (im.plum:plumbox-client).
//
// The Kotlin counterpart of @plumbox/client (packages/client): delegated
// OAuth (PKCE) for companion apps, the refreshing PlumClient, and the Drive
// calls. Everything except PlumAuthorization (Custom Tabs) and
// KeystoreTokenStore (Android Keystore) is plain JVM Kotlin, so the unit
// tests run on the JVM against a fake box (OkHttp MockWebServer).
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("com.android.library")
    `maven-publish`
}

group = providers.gradleProperty("plumboxClientGroup").get()
version = providers.gradleProperty("plumboxClientVersion").get()

android {
    namespace = "im.plum.plumbox.client"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        // What an app needs to compile against this AAR. AGP would stamp our
        // own compileSdk (36) here; the real floor is androidx.browser 1.8.0's
        // 34 — the library itself uses nothing above API 24.
        aarMetadata {
            minCompileSdk = 34
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    buildTypes {
        release {
            // A library is shrunk by the app that uses it (consumer-rules.pro).
            isMinifyEnabled = false
        }
    }

    testOptions {
        unitTests {
            // KeystoreTokenStore's codec test touches no android.* API, but
            // keep stray android.jar stubs from throwing if one sneaks in.
            isReturnDefaultValues = true
        }
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

kotlin {
    // A library: every public declaration states its visibility and type.
    explicitApi()
    // Do not pull apps onto a newer Kotlin than kotlinx-coroutines 1.10 already
    // does: Kotlin 2.1 metadata and kotlin-stdlib 2.1.0, readable by an app's
    // Kotlin 2.0 compiler (a compiler reads metadata one version ahead).
    coreLibrariesVersion = "2.1.0"
    compilerOptions {
        apiVersion.set(KotlinVersion.KOTLIN_2_1)
        languageVersion.set(KotlinVersion.KOTLIN_2_1)
    }
}

dependencies {
    // Public API types: Flow (drive.listAll) and OkHttpClient (OkHttpAdapter).
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    // Custom Tabs: the system browser, never a WebView (RFC 8252). 1.8.0, not
    // 1.9: 1.9 makes every app compile against API 36 with AGP 8.9.1+.
    implementation("androidx.browser:browser:1.8.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // org.json is part of Android; on the JVM the android.jar stubs would
    // return nothing, so the tests get the real implementation.
    testImplementation("org.json:json:20240303")
}

// Prepared, not published: the coordinate and the POM are set up so a release
// is one `publish` away once a repository is chosen. No repository is
// configured here on purpose — nothing in this build uploads anywhere.
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = providers.gradleProperty("plumboxClientGroup").get()
                artifactId = providers.gradleProperty("plumboxClientArtifact").get()
                version = project.version.toString()
                pom {
                    name.set("PlumBox client for Android")
                    description.set(
                        "Connect a third-party Android app to a user's Plum Box: delegated OAuth " +
                            "(Authorization Code + PKCE) in the system browser, a client that keeps the " +
                            "hourly access token fresh, and the Drive API. Mirrors @plumbox/client.",
                    )
                    url.set("https://github.com/plum-networks/plum-sdk")
                    licenses {
                        license {
                            name.set("MIT")
                            url.set("https://opensource.org/licenses/MIT")
                        }
                    }
                    organization {
                        name.set("Plum Networks")
                        url.set("https://plum.im")
                    }
                    scm {
                        url.set("https://github.com/plum-networks/plum-sdk")
                    }
                }
            }
        }
    }
}
