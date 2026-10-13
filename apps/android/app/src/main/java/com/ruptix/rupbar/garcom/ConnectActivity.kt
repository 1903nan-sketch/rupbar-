package com.ruptix.rupbar.garcom

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import java.net.Inet4Address
import kotlin.concurrent.thread

/**
 * Tela inicial: encontra o PC do bar e abre a interface do garçom.
 *
 * Ordem: (1) endereço sugerido pela interface e último endereço salvo;
 * (2) varredura da sub-rede do Wi-Fi em http://x.x.x.x:7420/api/discovery;
 * (3) endereço digitado. Sem Wi-Fi, espera a conexão e tenta de novo sozinha.
 */
class ConnectActivity : Activity(), Scanner.Listener {

    private enum class State { IDLE, CHECKING, SCANNING, NOT_FOUND, NO_WIFI, MANUAL, OPENING }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var cm: ConnectivityManager
    private lateinit var store: ServerStore

    private var state = State.IDLE

    /** Invalida respostas de tentativas anteriores (cada tentativa incrementa). */
    private var generation = 0
    private var scanner: Scanner? = null
    private var scanLabel = ""
    private var wifiCallback: ConnectivityManager.NetworkCallback? = null

    /** "Trocar PC": ignora o endereço salvo e não prefere o estabelecimento salvo. */
    private var switching = false

    /** Veio da tela do garçom porque o PC parou de responder. */
    private var rescan = false

    /** Endereço sugerido pela interface (ela achou o PC em outro IP). */
    private var hint: Server? = null

    /** Tela visível (entre onStart e onStop): só então a busca pode abrir a próxima tela. */
    private var visible = false

    private lateinit var statusCard: View
    private lateinit var statusTitle: TextView
    private lateinit var statusDetail: TextView
    private lateinit var progress: ProgressBar
    private lateinit var retryButton: Button
    private lateinit var wifiButton: Button
    private lateinit var manualButton: Button
    private lateinit var manualCard: View
    private lateinit var hostInput: EditText
    private lateinit var portInput: EditText
    private lateinit var manualStatus: TextView
    private lateinit var connectButton: Button

    private val autoRetry = Runnable { if (visible && state == State.NOT_FOUND) startDiscovery() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connect)
        cm = getSystemService(ConnectivityManager::class.java)!!
        store = ServerStore(this)
        // As sondagens escolhem a rede explicitamente; desfaz o vínculo antigo do WebView.
        Lan.bindProcess(cm, null)

        statusCard = find(R.id.statusCard)
        statusTitle = find(R.id.statusTitle)
        statusDetail = find(R.id.statusDetail)
        progress = find(R.id.progress)
        retryButton = find(R.id.retryButton)
        wifiButton = find(R.id.wifiButton)
        manualButton = find(R.id.manualButton)
        manualCard = find(R.id.manualCard)
        hostInput = find(R.id.hostInput)
        portInput = find(R.id.portInput)
        manualStatus = find(R.id.manualStatus)
        connectButton = find(R.id.connectButton)
        find<TextView>(R.id.versionText).text = getString(R.string.footer_version, BuildConfig.VERSION_NAME)
        SystemBars.setup(this, find(R.id.root), getColor(R.color.brand_bg), lightBars = false)

        retryButton.setOnClickListener { startDiscovery() }
        wifiButton.setOnClickListener { openWifiSettings() }
        manualButton.setOnClickListener { showManual() }
        connectButton.setOnClickListener { connectManual() }
        find<Button>(R.id.autoButton).setOnClickListener { startDiscovery() }
        portInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                connectManual()
                true
            } else {
                false
            }
        }

        switching = intent.action == ACTION_SWITCH
        rescan = intent.getBooleanExtra(EXTRA_RESCAN, false)
        hint = intent.getStringExtra(EXTRA_HINT_HOST)?.let { Server(it, intent.getIntExtra(EXTRA_HINT_PORT, Discovery.DEFAULT_PORT)) }
        if (switching) showManual()
    }

    override fun onStart() {
        super.onStart()
        visible = true
        if (state == State.IDLE || state == State.NOT_FOUND || state == State.NO_WIFI) startDiscovery()
    }

    override fun onStop() {
        super.onStop()
        visible = false
        unregisterWifiCallback()
        main.removeCallbacks(autoRetry)
        // Nada de abrir telas com o app em segundo plano: retoma ao voltar.
        when (state) {
            State.CHECKING, State.SCANNING -> {
                cancelWork()
                state = State.IDLE
            }
            State.MANUAL -> {
                cancelWork()
                connectButton.isEnabled = true
                manualStatus.visibility = View.GONE
            }
            else -> Unit
        }
    }

    override fun onDestroy() {
        cancelWork()
        unregisterWifiCallback()
        super.onDestroy()
    }

    // ------------------------------------------------------------- busca

    private fun cancelWork() {
        generation++
        scanner?.cancel()
        scanner = null
        main.removeCallbacks(autoRetry)
    }

    private fun startDiscovery() {
        cancelWork()
        hideKeyboard()
        manualCard.visibility = View.GONE
        statusCard.visibility = View.VISIBLE
        val gen = generation
        val saved = store.load()
        val preferred = if (switching) null else saved
        val candidates = buildList {
            hint?.let { add(it) }
            if (!switching && saved != null) add(saved)
        }.distinctBy { it.origin }
        hint = null
        val fromWebView = rescan
        rescan = false
        if (candidates.isEmpty()) {
            scanNetwork(preferred)
            return
        }
        state = State.CHECKING
        if (fromWebView) {
            showStatus(getString(R.string.status_rescan), getString(R.string.status_rescan_detail), progressMax = 0)
        } else {
            showStatus(getString(R.string.status_checking), getString(R.string.status_checking_detail, candidates.first().label), progressMax = 0)
        }
        thread(name = "rupbar-check", isDaemon = true) {
            var found: Server? = null
            for (c in candidates) {
                val server = Discovery.probe(Lan.networkFor(cm, c.host), c.host, c.port, 1500, 2500)
                if (server != null && server.sameEstablishment(preferred)) {
                    found = server
                    break
                }
            }
            val result = found
            main.post {
                if (gen != generation) return@post
                if (result != null) open(result) else scanNetwork(preferred)
            }
        }
    }

    private fun scanNetwork(preferred: Server?) {
        val lans = Lan.interfaces(cm)
        val targets = lans
            .flatMap { lan -> Lan.hostsToScan(lan, preferred?.host).map { ScanTarget(lan.network, it) } }
            .distinctBy { it.host }
        if (targets.isEmpty()) {
            showNoWifi()
            return
        }
        state = State.SCANNING
        scanLabel = lans.map { it.label }.distinct().joinToString(", ")
        showStatus(
            getString(R.string.status_scanning),
            getString(R.string.status_scanning_detail, scanLabel, 0, targets.size),
            progressMax = targets.size,
        )
        scanner = Scanner(targets, preferred?.port ?: Discovery.DEFAULT_PORT, preferred?.establishmentId, this).also { it.start() }
    }

    override fun onScanProgress(done: Int, total: Int) {
        if (state != State.SCANNING) return
        progress.max = total
        progress.progress = done
        statusDetail.text = getString(R.string.status_scanning_detail, scanLabel, done, total)
    }

    override fun onScanFinished(server: Server?) {
        if (state != State.SCANNING) return
        scanner = null
        if (server != null) open(server) else showNotFound()
    }

    private fun showNotFound() {
        if (Lan.interfaces(cm).isEmpty()) {
            showNoWifi()
            return
        }
        state = State.NOT_FOUND
        showStatus(getString(R.string.status_not_found), getString(R.string.status_not_found_detail), progressMax = -1, idle = true)
        main.removeCallbacks(autoRetry)
        main.postDelayed(autoRetry, AUTO_RETRY_MS)
    }

    private fun showNoWifi() {
        state = State.NO_WIFI
        showStatus(getString(R.string.status_no_wifi), getString(R.string.status_no_wifi_detail), progressMax = -1, idle = true)
        registerWifiCallback()
    }

    /** progressMax: -1 oculto, 0 indeterminado, >0 determinado. */
    private fun showStatus(title: String, detail: String, progressMax: Int, idle: Boolean = false) {
        manualCard.visibility = View.GONE
        statusCard.visibility = View.VISIBLE
        statusTitle.text = title
        statusDetail.text = detail
        progress.visibility = if (progressMax < 0) View.GONE else View.VISIBLE
        progress.isIndeterminate = progressMax == 0
        if (progressMax > 0) {
            progress.max = progressMax
            progress.progress = 0
        }
        retryButton.visibility = if (idle) View.VISIBLE else View.GONE
        wifiButton.visibility = if (idle) View.VISIBLE else View.GONE
    }

    private fun open(server: Server) {
        cancelWork()
        state = State.OPENING
        val previous = store.load()
        store.save(server)
        showStatus(getString(R.string.status_found, server.name ?: server.label), server.label, progressMax = 0)
        // Mesmo estabelecimento em outro IP: a tela do garçom leva o login junto.
        val migrateFrom = previous?.takeIf {
            it.origin != server.origin && it.establishmentId != null && it.establishmentId == server.establishmentId
        }
        startActivity(WebAppActivity.launchIntent(this, server, migrateFrom))
        finish()
    }

    // ---------------------------------------------------------- endereço digitado

    private fun showManual() {
        cancelWork()
        state = State.MANUAL
        statusCard.visibility = View.GONE
        manualCard.visibility = View.VISIBLE
        manualStatus.visibility = View.GONE
        connectButton.isEnabled = true
        val saved = store.load()
        if (hostInput.text.isNullOrBlank()) {
            // Sugere o endereço salvo ou o começo da rede do celular (ex.: "192.168.0.").
            val prefill = saved?.host
                ?: Lan.interfaces(cm).firstOrNull()?.let { Lan.format(it.address).substringBeforeLast('.') + "." }
            hostInput.setText(prefill.orEmpty())
        }
        if (portInput.text.isNullOrBlank()) portInput.setText((saved?.port ?: Discovery.DEFAULT_PORT).toString())
        hostInput.requestFocus()
        hostInput.setSelection(hostInput.text.length)
        hostInput.post {
            getSystemService(InputMethodManager::class.java)?.showSoftInput(hostInput, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun connectManual() {
        val address = parseAddress(hostInput.text.toString(), portInput.text.toString())
        if (address == null) {
            showManualMessage(getString(R.string.manual_invalid), error = true)
            return
        }
        val target = Server(address.first, address.second)
        cancelWork()
        val gen = generation
        hideKeyboard()
        connectButton.isEnabled = false
        showManualMessage(getString(R.string.manual_checking, target.label), error = false)
        thread(name = "rupbar-manual", isDaemon = true) {
            val server = Discovery.probe(Lan.networkFor(cm, target.host), target.host, target.port, 3000, 4000)
            main.post {
                if (gen != generation || state != State.MANUAL) return@post
                connectButton.isEnabled = true
                if (server != null) open(server) else showManualMessage(getString(R.string.manual_failed, target.label), error = true)
            }
        }
    }

    private fun showManualMessage(text: String, error: Boolean) {
        manualStatus.visibility = View.VISIBLE
        manualStatus.text = text
        manualStatus.setTextColor(getColor(if (error) R.color.brand_danger else R.color.brand_text_muted))
    }

    // ------------------------------------------------------------- Wi-Fi

    private fun openWifiSettings() {
        val panel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) Intent(Settings.Panel.ACTION_WIFI) else null
        for (intent in listOfNotNull(panel, Intent(Settings.ACTION_WIFI_SETTINGS), Intent(Settings.ACTION_WIRELESS_SETTINGS))) {
            try {
                startActivity(intent)
                return
            } catch (e: ActivityNotFoundException) {
                // Tenta a próxima opção.
            }
        }
    }

    /** Recomeça a busca assim que um Wi-Fi (ou cabo) ganhar endereço IPv4. */
    private fun registerWifiCallback() {
        if (wifiCallback != null) return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            // O Wi-Fi do bar pode não ter internet.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // Android 7 nem sempre avisa onLinkPropertiesChanged para uma rede nova.
                main.postDelayed({ if (visible && state == State.NO_WIFI) startDiscovery() }, 1500)
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                if (linkProperties.linkAddresses.any { it.address is Inet4Address }) {
                    main.postDelayed({ if (visible && state == State.NO_WIFI) startDiscovery() }, 800)
                }
            }
        }
        try {
            cm.registerNetworkCallback(request, callback)
            wifiCallback = callback
        } catch (e: RuntimeException) {
            // Sem callback: o botão "Procurar novamente" continua disponível.
        }
    }

    private fun unregisterWifiCallback() {
        val callback = wifiCallback ?: return
        wifiCallback = null
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (e: RuntimeException) {
            // Já removido.
        }
    }

    private fun <T : View> find(id: Int): T = requireNotNull(findViewById<T>(id))

    private fun hideKeyboard() {
        getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(window.decorView.windowToken, 0)
    }

    companion object {
        /** Ação do atalho "Trocar PC" (res/xml/shortcuts.xml) e do menu da tela do garçom. */
        const val ACTION_SWITCH = "com.ruptix.rupbar.garcom.TROCAR_PC"
        private const val EXTRA_RESCAN = "rescan"
        private const val EXTRA_HINT_HOST = "hintHost"
        private const val EXTRA_HINT_PORT = "hintPort"
        private const val AUTO_RETRY_MS = 15_000L

        /** Volta para a busca (o PC não respondeu); [hint] é testado primeiro. */
        fun rescanIntent(context: Context, hint: Server?): Intent =
            Intent(context, ConnectActivity::class.java).putExtra(EXTRA_RESCAN, true).apply {
                if (hint != null) {
                    putExtra(EXTRA_HINT_HOST, hint.host)
                    putExtra(EXTRA_HINT_PORT, hint.port)
                }
            }

        fun switchIntent(context: Context): Intent =
            Intent(context, ConnectActivity::class.java).setAction(ACTION_SWITCH)

        /**
         * Lê o que foi digitado: "192.168.0.10", "192.168.0.10:7420",
         * "http://192.168.0.10:7420/m" ou um nome (ex.: "rupbar.local").
         */
        fun parseAddress(hostText: String, portText: String): Pair<String, Int>? {
            var text = hostText.trim().replace(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "")
            text = text.substringBefore('/').substringBefore('?').substringBefore('#')
            var port = portText.trim().toIntOrNull() ?: Discovery.DEFAULT_PORT
            if (text.count { it == ':' } == 1) {
                port = text.substringAfter(':').toIntOrNull() ?: return null
                text = text.substringBefore(':')
            }
            if (port !in 1..65535) return null
            val host = text.trimEnd('.').lowercase()
            if (host.isEmpty() || host.length > 253) return null
            if (host.all { it.isDigit() || it == '.' }) return if (Lan.parseIpv4(host) != null) host to port else null
            val label = "[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            return if (Regex("^$label(\\.$label)*$").matches(host)) host to port else null
        }
    }
}
