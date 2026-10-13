package com.ruptix.rupbar.garcom

import android.net.Network
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Descoberta do PC do bar.
 *
 * O servidor local responde em GET /api/discovery com
 * `{"app":"rupbar","establishmentId":"…","name":"…","port":7420}`;
 * só aceitamos respostas com essa assinatura.
 */
object Discovery {
    const val DEFAULT_PORT = 7420
    private const val MAX_BODY = 8 * 1024

    /** Testa um endereço. Bloqueante: chame fora da thread principal. */
    fun probe(network: Network?, host: String, port: Int, connectTimeoutMs: Int, readTimeoutMs: Int): Server? {
        val url = try {
            URL("http", host, port, "/api/discovery")
        } catch (e: Exception) {
            return null
        }
        var conn: HttpURLConnection? = null
        return try {
            conn = (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.useCaches = false
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "RupBarGarcom/${BuildConfig.VERSION_NAME}")
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = conn.inputStream.use { readLimited(it) } ?: return null
            val json = JSONObject(body)
            if (json.optString("app") != "rupbar") return null
            Server(
                host = host,
                port = port,
                establishmentId = json.stringOrNull("establishmentId"),
                name = json.stringOrNull("name"),
            )
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun JSONObject.stringOrNull(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotBlank() }

    private fun readLimited(input: InputStream): String? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(2048)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > MAX_BODY) return null
        }
        return out.toString("UTF-8")
    }
}

/**
 * Varredura da rede local com concorrência limitada ([PARALLEL] conexões) e
 * tempos curtos. Para no primeiro PC do mesmo estabelecimento; se só achar PCs
 * de outro estabelecimento (ex.: RupBar reinstalado), usa o primeiro deles.
 */
class Scanner(
    private val targets: List<ScanTarget>,
    private val port: Int,
    private val preferredEstablishment: String?,
    private val listener: Listener,
) {
    interface Listener {
        fun onScanProgress(done: Int, total: Int)
        fun onScanFinished(server: Server?)
    }

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var cancelled = false

    @Volatile
    private var pool: ExecutorService? = null

    fun start() {
        thread(name = "rupbar-scan", isDaemon = true) { run() }
    }

    fun cancel() {
        cancelled = true
        pool?.shutdownNow()
    }

    private fun run() {
        val executor = Executors.newFixedThreadPool(PARALLEL)
        pool = executor
        if (cancelled) executor.shutdownNow()
        val completion = ExecutorCompletionService<Server?>(executor)
        var found: Server? = null
        var fallback: Server? = null
        var done = 0
        try {
            for (t in targets) {
                completion.submit {
                    if (cancelled) null else Discovery.probe(t.network, t.host, port, CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS)
                }
            }
            while (done < targets.size && !cancelled) {
                val server = try {
                    completion.take().get()
                } catch (e: java.util.concurrent.ExecutionException) {
                    null
                }
                done++
                val progress = done
                main.post { if (!cancelled) listener.onScanProgress(progress, targets.size) }
                if (server == null) continue
                if (preferredEstablishment == null || server.establishmentId == null ||
                    server.establishmentId == preferredEstablishment
                ) {
                    found = server
                    break
                }
                if (fallback == null) fallback = server
            }
        } catch (e: InterruptedException) {
            // Cancelada.
        } catch (e: java.util.concurrent.RejectedExecutionException) {
            // Cancelada antes de enfileirar tudo.
        } finally {
            executor.shutdownNow()
        }
        val result = found ?: fallback
        main.post { if (!cancelled) listener.onScanFinished(result) }
    }

    companion object {
        const val PARALLEL = 32
        const val CONNECT_TIMEOUT_MS = 900
        const val READ_TIMEOUT_MS = 1500
    }
}
