import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versão do app: -PrupbarVersion=1.2.3 ou a versão do package.json da raiz do monorepo.
val rootPackageJson = rootProject.layout.projectDirectory.file("../../package.json").asFile
val appVersionName: String = (findProperty("rupbarVersion") as String?)?.takeIf { it.isNotBlank() }
    ?: rootPackageJson.takeIf { it.isFile }?.readText()
        ?.let { Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(it)?.groupValues?.get(1) }
    ?: "0.0.0"

// versionCode cresce com a versão (1.2.3 -> 1002003) para que atualizações instalem por cima.
val appVersionCode: Int = (findProperty("rupbarVersionCode") as String?)?.toIntOrNull()
    ?: appVersionName.substringBefore('-').split('.')
        .map { part -> part.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
        .plus(listOf(0, 0, 0))
        .let { (major, minor, patch) -> (major * 1_000_000 + minor * 1_000 + patch).coerceAtLeast(1) }

// Assinatura estável (opcional): sem ela, o APK sai com a chave de depuração do
// computador que compilou e uma atualização pode exigir desinstalar o app antigo.
val keystorePath: String? = providers.environmentVariable("RUPBAR_KEYSTORE").orNull?.takeIf { it.isNotBlank() }

android {
    namespace = "com.ruptix.rupbar.garcom"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ruptix.rupbar.garcom"
        minSdk = 24
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (keystorePath != null && file(keystorePath).isFile) {
            create("rupbar") {
                storeFile = file(keystorePath)
                storePassword = providers.environmentVariable("RUPBAR_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("RUPBAR_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("RUPBAR_KEY_PASSWORD").orNull
                    ?: providers.environmentVariable("RUPBAR_KEYSTORE_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            // App pequeno, sem bibliotecas: sem R8 para não arriscar a ponte JavaScript.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("rupbar") ?: signingConfigs.getByName("debug")
        }
        debug {
            signingConfigs.findByName("rupbar")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // O CI só precisa do APK; a análise completa pode ser feita com `gradle lint`.
        checkReleaseBuilds = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// Sem dependências além da biblioteca padrão do Kotlin: só APIs do Android.
