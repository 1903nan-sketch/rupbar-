package com.ruptix.rupbar.garcom

import android.content.Context

/** Servidor local do RupBar (PC do bar) confirmado por GET /api/discovery. */
data class Server(
    val host: String,
    val port: Int,
    val establishmentId: String? = null,
    val name: String? = null,
) {
    /** Origem usada no WebView, ex.: http://192.168.0.10:7420 */
    val origin: String get() = "http://${host.lowercase()}:$port"

    /** Endereço para mostrar ao usuário (sem a porta padrão). */
    val label: String get() = if (port == Discovery.DEFAULT_PORT) host else "$host:$port"

    /** Mesmo estabelecimento (ou sem como saber). */
    fun sameEstablishment(other: Server?): Boolean =
        other == null || establishmentId == null || other.establishmentId == null || establishmentId == other.establishmentId
}

/** Último PC encontrado, para reconectar direto na próxima abertura. */
class ServerStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("rupbar", Context.MODE_PRIVATE)

    fun load(): Server? {
        val host = prefs.getString(KEY_HOST, null)?.takeIf { it.isNotBlank() } ?: return null
        val port = prefs.getInt(KEY_PORT, Discovery.DEFAULT_PORT).takeIf { it in 1..65535 } ?: Discovery.DEFAULT_PORT
        return Server(host, port, prefs.getString(KEY_ESTABLISHMENT, null), prefs.getString(KEY_NAME, null))
    }

    fun save(server: Server) {
        prefs.edit()
            .putString(KEY_HOST, server.host)
            .putInt(KEY_PORT, server.port)
            .putString(KEY_ESTABLISHMENT, server.establishmentId)
            .putString(KEY_NAME, server.name)
            .apply()
    }

    private companion object {
        const val KEY_HOST = "host"
        const val KEY_PORT = "port"
        const val KEY_ESTABLISHMENT = "establishmentId"
        const val KEY_NAME = "name"
    }
}
