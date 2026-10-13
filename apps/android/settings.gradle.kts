// App Android "RupBar Garçom": casca nativa que encontra o PC do bar na rede
// local e abre a interface do garçom (/m) em um WebView.
pluginManagement {
    repositories {
        google()
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

rootProject.name = "rupbar-garcom"
include(":app")
