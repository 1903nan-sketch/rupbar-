package com.ruptix.rupbar.garcom

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface

/**
 * Ponte JavaScript `window.RupBarAndroid` (mínima de propósito):
 *  - `vibrate(ms)`: vibração curta (a interface chama após enviar um pedido);
 *  - `appVersion()`: versão do app Android.
 *
 * Os métodos rodam numa thread do WebView e só respondem enquanto a página
 * carregada for a origem do RupBar confirmada pela descoberta ([isTrustedPage]).
 */
class RupBarBridge(
    context: Context,
    private val isTrustedPage: () -> Boolean,
) {
    private val appContext = context.applicationContext

    @JavascriptInterface
    fun vibrate(ms: Int) {
        if (!isTrustedPage()) return
        Haptics.vibrate(appContext, ms.coerceIn(1, 1000).toLong())
    }

    @JavascriptInterface
    fun appVersion(): String = if (isTrustedPage()) BuildConfig.VERSION_NAME else ""

    companion object {
        const val NAME = "RupBarAndroid"
    }
}

object Haptics {
    fun vibrate(context: Context, ms: Long) {
        try {
            val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (vibrator == null || !vibrator.hasVibrator()) return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(ms)
            }
        } catch (e: RuntimeException) {
            // Vibração indisponível neste aparelho: ignora.
        }
    }
}
