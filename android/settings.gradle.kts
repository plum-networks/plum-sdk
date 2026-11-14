// PlumBox client for Android — im.plum:plumbox-client.
//
// A standalone Gradle build: open this folder (android/) in Android Studio,
// or run ./gradlew from here. The JS/TS SDK in ../packages is not part of it.
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "plumbox-client-android"
include(":plumbox-client")
