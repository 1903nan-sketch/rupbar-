package com.ruptix.rupbar.garcom

import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController

/**
 * Barras do sistema.
 *
 * Android 11+: tela de ponta a ponta (obrigatória no Android 15 com targetSdk 35);
 * a área das barras, do recorte da câmera e do teclado vira margem interna de
 * [content], cujo fundo pinta atrás das barras.
 * Android 7 a 10: barras opacas na cor do fundo e redimensionamento padrão do teclado.
 */
object SystemBars {
    fun setup(activity: Activity, content: View, barColor: Int, lightBars: Boolean) {
        val window = activity.window
        content.setBackgroundColor(barColor)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION") // ainda necessário no Android 11 a 14
            window.setDecorFitsSystemWindows(false)
            @Suppress("DEPRECATION")
            window.statusBarColor = Color.TRANSPARENT
            @Suppress("DEPRECATION")
            window.navigationBarColor = Color.TRANSPARENT
            window.isNavigationBarContrastEnforced = false
            val lightFlags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (lightBars) lightFlags else 0, lightFlags)
            content.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
                if (ime.bottom > 0) view.post { revealFocused(view) }
                WindowInsets.CONSUMED
            }
            content.requestApplyInsets()
        } else {
            @Suppress("DEPRECATION")
            run {
                window.statusBarColor = barColor
                var flags = window.decorView.systemUiVisibility
                flags = if (lightBars) {
                    flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                } else {
                    flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    window.navigationBarColor = barColor
                    flags = if (lightBars) {
                        flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                    } else {
                        flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                    }
                } else {
                    // Antes do Android 8.1 os ícones da barra de navegação são sempre claros.
                    window.navigationBarColor = Color.BLACK
                }
                window.decorView.systemUiVisibility = flags
            }
        }
    }

    /** Com o teclado aberto, rola até o campo em edição (o ScrollView não faz isso sozinho). */
    private fun revealFocused(root: View) {
        val focused = root.findFocus() ?: return
        val rect = Rect()
        focused.getDrawingRect(rect)
        focused.requestRectangleOnScreen(rect, false)
    }
}
