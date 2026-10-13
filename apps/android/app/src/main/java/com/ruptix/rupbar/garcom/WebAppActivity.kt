package com.ruptix.rupbar.garcom

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import kotlin.concurrent.thread

/**
 * Interface do garçom (http://<ip>:<porta>/m) em tela cheia.
 *
 * Se o PC deixar de responder (IP mudou, PC desligado), volta sozinho para a
 * busca ([ConnectActivity]). Voltar navega no histórico; no início do histórico
 * abre o menu com "Trocar PC / Reconectar".
 */
class WebAppActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var cm: ConnectivityManager
    private lateinit var server: Server
    private lateinit var root: FrameLayout
    private lateinit var progress: ProgressBar
    private var webView: WebView? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var stoppedAt = 0L

    /** Origem confirmada pela descoberta (ex.: http://192.168.0.10:7420). */
    @Volatile
    private var trustedOrigin = ""

    /** Origem da página carregada agora (lida pela ponte JavaScript em outra thread). */
    @Volatile
    private var currentOrigin: String? = null

    @Volatile
    private var leaving = false

    @Volatile
    private var healthGeneration = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cm = getSystemService(ConnectivityManager::class.java)!!
        val host = intent.getStringExtra(EXTRA_HOST)
        if (host == null) {
            startActivity(Intent(this, ConnectActivity::class.java))
            finish()
            return
        }
        server = Server(
            host = host,
            port = intent.getIntExtra(EXTRA_PORT, Discovery.DEFAULT_PORT),
            establishmentId = intent.getStringExtra(EXTRA_ESTABLISHMENT),
            name = intent.getStringExtra(EXTRA_NAME),
        )
        trustedOrigin = server.origin

        // Wi-Fi do bar sem internet + dados móveis ligados: o WebView precisa sair pelo Wi-Fi.
        Lan.bindProcessFor(cm, server.host)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        root = FrameLayout(this)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = false
            progressTintList = ColorStateList.valueOf(getColor(R.color.brand_orange))
            visibility = View.GONE
        }
        setContentView(root)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        SystemBars.setup(this, root, getColor(R.color.web_bg), lightBars = !night)

        val web = try {
            WebView(this)
        } catch (e: Exception) {
            // Sem "Android System WebView" (ou sendo atualizado no momento).
            showWebViewMissing()
            return
        }
        webView = web
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(
            progress,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP),
        )
        configure(web)
        setupBack()

        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) return
        migrateSession { webView?.loadUrl("${server.origin}/m") }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(web: WebView) {
        web.setBackgroundColor(getColor(R.color.web_bg))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString RupBarGarcom/${BuildConfig.VERSION_NAME}"
        }
        // Login persistente: cookies gravados em disco (flush ao pausar e ao terminar cada página).
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.addJavascriptInterface(
            RupBarBridge(this) { !leaving && currentOrigin == trustedOrigin },
            RupBarBridge.NAME,
        )
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        web.setDownloadListener { url, _, _, _, _ -> openExternal(Uri.parse(url)) }
    }

    /**
     * O mesmo estabelecimento em outro IP é outra origem para o WebView: copia o
     * cookie de sessão (o token vale para o PC, não para o endereço) para não
     * pedir login de novo ao garçom.
     */
    private fun migrateSession(then: () -> Unit) {
        val previous = intent.getStringExtra(EXTRA_PREVIOUS_ORIGIN)
        if (previous == null) {
            then()
            return
        }
        try {
            val cookies = CookieManager.getInstance()
            val already = cookies.getCookie(server.origin)?.contains("$SESSION_COOKIE=") == true
            val token = cookies.getCookie(previous)
                ?.split(';')
                ?.map { it.trim() }
                ?.firstOrNull { it.startsWith("$SESSION_COOKIE=") }
                ?.substringAfter('=')
                ?.takeIf { it.isNotEmpty() }
            if (already || token == null) {
                then()
                return
            }
            val value = "$SESSION_COOKIE=$token; Path=/; Max-Age=$SESSION_MAX_AGE; HttpOnly; SameSite=Strict"
            cookies.setCookie(server.origin, value) {
                cookies.flush()
                then()
            }
        } catch (e: RuntimeException) {
            then()
        }
    }

    // ------------------------------------------------------------- ciclo de vida

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        // Voltou depois de um tempo (tela bloqueada): confere se o PC ainda está no mesmo IP.
        if (stoppedAt > 0 && SystemClock.elapsedRealtime() - stoppedAt > HEALTH_AFTER_BACKGROUND_MS) checkServer()
        stoppedAt = 0
    }

    override fun onPause() {
        webView?.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        stoppedAt = SystemClock.elapsedRealtime()
        healthGeneration++
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    override fun onDestroy() {
        healthGeneration++
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        webView?.let {
            root.removeView(it)
            it.stopLoading()
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }

    @Deprecated("Usado só antes do Android 13; depois vale o OnBackInvokedCallback.")
    override fun onBackPressed() {
        handleBack()
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQUEST_FILES) {
            fileCallback?.onReceiveValue(parseFiles(resultCode, data))
            fileCallback = null
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    // ------------------------------------------------------------- navegação

    private fun setupBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                OnBackInvokedCallback { handleBack() },
            )
        }
    }

    private fun handleBack() {
        val web = webView
        if (web != null && web.canGoBack()) web.goBack() else showMenu()
    }

    private fun showMenu() {
        if (isFinishing) return
        val items = arrayOf(getString(R.string.menu_reload), getString(R.string.menu_switch), getString(R.string.menu_exit))
        AlertDialog.Builder(this)
            .setTitle(server.name ?: getString(R.string.app_name))
            .setItems(items) { _, which ->
                when (which) {
                    0 -> webView?.reload()
                    1 -> leaveTo(ConnectActivity.switchIntent(this))
                    else -> finish()
                }
            }
            .show()
    }

    /** O PC não respondeu: volta para a busca (testando antes o [hint], se houver). */
    private fun rediscover(hint: Server?) {
        leaveTo(ConnectActivity.rescanIntent(this, hint))
    }

    private fun leaveTo(intent: Intent) {
        if (leaving) return
        leaving = true
        healthGeneration++
        startActivity(intent)
        finish()
    }

    /** Confere o PC em segundo plano (3 tentativas: o Wi-Fi pode estar reconectando). */
    private fun checkServer() {
        val gen = ++healthGeneration
        val target = server
        thread(name = "rupbar-health", isDaemon = true) {
            var ok = false
            for (attempt in 0 until 3) {
                if (gen != healthGeneration) return@thread
                // A rede Wi-Fi pode ter mudado de identificador ao reconectar: vincula de novo.
                val network = Lan.bindProcessFor(cm, target.host)
                val found = Discovery.probe(network, target.host, target.port, 2000, 2500)
                if (found != null && found.sameEstablishment(target)) {
                    ok = true
                    break
                }
                if (attempt < 2) {
                    try {
                        Thread.sleep(1500)
                    } catch (e: InterruptedException) {
                        return@thread
                    }
                }
            }
            if (!ok) main.post { if (gen == healthGeneration && !isFinishing) rediscover(null) }
        }
    }

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme in BLOCKED_SCHEMES) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    private fun showWebViewMissing() {
        AlertDialog.Builder(this)
            .setMessage(R.string.webview_missing)
            .setPositiveButton(R.string.ok) { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val uri = request.url
            if (originOf(uri.toString()) == trustedOrigin) return false
            val host = uri.host?.lowercase()
            val port = if (uri.port != -1) uri.port else 80
            val maybeRupBar = Lan.isPrivateIpv4(host) || host?.endsWith(".local") == true || port == server.port
            if (uri.scheme.equals("http", ignoreCase = true) && host != null && maybeRupBar) {
                // A própria interface achou o PC em outro endereço: confirma pela descoberta
                // nativa (assinatura e estabelecimento) antes de confiar na nova origem.
                rediscover(Server(host, port))
                return true
            }
            openExternal(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            currentOrigin = originOf(url)
            progress.visibility = View.VISIBLE
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            currentOrigin = originOf(url)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            progress.visibility = View.GONE
            CookieManager.getInstance().flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame || originOf(request.url.toString()) != trustedOrigin) return
            if (error.errorCode in UNREACHABLE_ERRORS) {
                // PC fora do ar no endereço salvo (IP mudou, PC desligado): volta para a busca.
                rediscover(null)
            } else {
                // Outros erros: só sai da tela se o PC realmente não responder.
                checkServer()
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // O Android encerrou o processo da página (falta de memória): recria a tela.
            if (view === webView) {
                root.removeView(view)
                view.destroy()
                webView = null
                leaveTo(launchIntent(this@WebAppActivity, server, null))
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            progress.progress = newProgress
            if (newProgress >= 100) progress.visibility = View.GONE
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(params.createIntent(), REQUEST_FILES)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                Toast.makeText(this@WebAppActivity, R.string.file_chooser_failed, Toast.LENGTH_SHORT).show()
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // A interface do garçom não usa câmera nem microfone.
            request.deny()
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }
    }

    companion object {
        private const val EXTRA_HOST = "host"
        private const val EXTRA_PORT = "port"
        private const val EXTRA_ESTABLISHMENT = "establishmentId"
        private const val EXTRA_NAME = "name"
        private const val EXTRA_PREVIOUS_ORIGIN = "previousOrigin"
        private const val REQUEST_FILES = 4101
        private const val HEALTH_AFTER_BACKGROUND_MS = 15_000L
        private const val SESSION_COOKIE = "rupbar_session"
        private const val SESSION_MAX_AGE = 30 * 24 * 3600
        private val BLOCKED_SCHEMES = setOf("javascript", "file", "content", "intent", "data", "blob", "about")
        private val UNREACHABLE_ERRORS = setOf(
            WebViewClient.ERROR_CONNECT,
            WebViewClient.ERROR_TIMEOUT,
            WebViewClient.ERROR_HOST_LOOKUP,
            WebViewClient.ERROR_IO,
        )

        fun launchIntent(context: Context, server: Server, migrateSessionFrom: Server?): Intent =
            Intent(context, WebAppActivity::class.java)
                .putExtra(EXTRA_HOST, server.host)
                .putExtra(EXTRA_PORT, server.port)
                .putExtra(EXTRA_ESTABLISHMENT, server.establishmentId)
                .putExtra(EXTRA_NAME, server.name)
                .apply { migrateSessionFrom?.let { putExtra(EXTRA_PREVIOUS_ORIGIN, it.origin) } }

        /** "http://Host:80/x" → "http://host:80" (porta sempre explícita, como em [Server.origin]). */
        fun originOf(url: String?): String? {
            val uri = url?.let(Uri::parse) ?: return null
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            val port = when {
                uri.port != -1 -> uri.port
                scheme == "http" -> 80
                scheme == "https" -> 443
                else -> -1
            }
            return "$scheme://$host:$port"
        }

        private fun parseFiles(resultCode: Int, data: Intent?): Array<Uri>? {
            if (resultCode != Activity.RESULT_OK || data == null) return null
            data.clipData?.let { clip -> return Array(clip.itemCount) { clip.getItemAt(it).uri } }
            return data.data?.let { arrayOf(it) }
        }
    }
}
