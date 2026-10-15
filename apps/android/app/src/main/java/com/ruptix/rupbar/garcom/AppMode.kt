package com.ruptix.rupbar.garcom

import android.app.UiModeManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration

/**
 * O mesmo app serve para o celular do garçom e para a TV de retirada (TV box).
 *
 * - Garçom: abre /m, sempre na vertical.
 * - TV: abre /tv, na horizontal e em tela cheia.
 *
 * Em TV box (Android TV ou aparelho sem tela de toque) o padrão é TV; dá para
 * trocar pelo menu (botão voltar no início da página).
 */
enum class AppMode(val path: String) {
    WAITER("/m"),
    TV("/tv");

    val orientation: Int
        get() = if (this == TV) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT

    companion object {
        private const val PREFS = "rupbar_mode"
        private const val KEY = "mode"

        fun current(context: Context): AppMode {
            val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            return when (saved) {
                TV.name -> TV
                WAITER.name -> WAITER
                else -> if (looksLikeTv(context)) TV else WAITER
            }
        }

        fun save(context: Context, mode: AppMode) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, mode.name).apply()
        }

        /** Android TV, ou TV box sem tela de toque (controle remoto). */
        fun looksLikeTv(context: Context): Boolean {
            val ui = context.getSystemService(UiModeManager::class.java)
            if (ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) return true
            val pm = context.packageManager
            return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
        }
    }
}
