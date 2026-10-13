package com.ruptix.rupbar.garcom

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.net.Inet4Address
import kotlin.math.abs

/** Rede local do celular (Wi-Fi ou cabo): endereço IPv4 e prefixo (ex.: /24). */
data class LanInterface(val network: Network, val address: Long, val prefix: Int) {
    /** Ex.: "192.168.0.x" (para mostrar durante a busca). */
    val label: String
        get() = Lan.format(address).substringBeforeLast('.') + ".x"
}

/** Endereço a testar na varredura e a rede pela qual a conexão deve sair. */
data class ScanTarget(val network: Network?, val host: String)

/**
 * Utilitários de rede local.
 *
 * Importante: quando o Wi-Fi do bar não tem internet, o Android costuma manter os
 * dados móveis como rede padrão e as conexões para 192.168.x.x sairiam pelo 4G.
 * Por isso as sondagens usam a rede Wi-Fi explicitamente e o processo é vinculado
 * a ela antes de abrir o WebView ([bindProcessFor]).
 */
object Lan {
    /** Redes Wi-Fi/Ethernet ativas com IPv4 (ignora VPN, loopback e link-local). */
    fun interfaces(cm: ConnectivityManager): List<LanInterface> {
        val out = mutableListOf<LanInterface>()
        @Suppress("DEPRECATION")
        val networks = try {
            cm.allNetworks
        } catch (e: RuntimeException) {
            emptyArray()
        }
        for (network in networks) {
            try {
                val caps = cm.getNetworkCapabilities(network) ?: continue
                val local = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                if (!local || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
                val props = cm.getLinkProperties(network) ?: continue
                for (link in props.linkAddresses) {
                    val addr = link.address as? Inet4Address ?: continue
                    if (addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isAnyLocalAddress) continue
                    out += LanInterface(network, toLong(addr.address), link.prefixLength)
                }
            } catch (e: RuntimeException) {
                // Rede desconectou durante a leitura: ignora.
            }
        }
        // Wi-Fi primeiro (é onde ficam os celulares da equipe).
        return out.distinctBy { it.address }.sortedBy { iface ->
            val caps = try { cm.getNetworkCapabilities(iface.network) } catch (e: RuntimeException) { null }
            if (caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) 0 else 1
        }
    }

    /** Rede local cuja sub-rede contém [host] (somente IPv4 literal). */
    fun networkFor(cm: ConnectivityManager, host: String): Network? {
        val ip = parseIpv4(host) ?: return null
        return interfaces(cm).firstOrNull { sameSubnet(it.address, ip, it.prefix) }?.network
    }

    /**
     * Faz todo o app (inclusive o WebView) sair pela rede local que alcança [host].
     * Sem rede correspondente, volta ao roteamento padrão do sistema.
     */
    fun bindProcessFor(cm: ConnectivityManager, host: String): Network? {
        val network = networkFor(cm, host)
        bindProcess(cm, network)
        return network
    }

    fun bindProcess(cm: ConnectivityManager, network: Network?) {
        try {
            cm.bindProcessToNetwork(network)
        } catch (e: RuntimeException) {
            // Sem permissão ou rede já desconectada: segue com o roteamento padrão.
        }
    }

    /**
     * Endereços a varrer: a sub-rede inteira se for /22 a /30; em redes maiores,
     * só o /24 do próprio celular. Ordem: perto do último IP conhecido do PC (DHCP
     * costuma dar um endereço próximo), depois o /24 do celular, depois o resto.
     */
    fun hostsToScan(lan: LanInterface, near: String?): List<String> {
        val prefix = when {
            lan.prefix > 30 -> return emptyList()
            lan.prefix >= 22 -> lan.prefix
            else -> 24
        }
        val size = 1L shl (32 - prefix)
        val mask = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
        val base = lan.address and mask
        val nearIp = near?.let(::parseIpv4)?.takeIf { (it and mask) == base }
        val own24 = lan.address ushr 8
        return (1L until size - 1)
            .map { base + it }
            .filter { it != lan.address }
            .sortedWith(
                compareBy<Long>(
                    { if (nearIp != null) abs(it - nearIp) else 0L },
                    { if (it ushr 8 == own24) 0 else 1 },
                    { it },
                ),
            )
            .map(::format)
    }

    fun sameSubnet(a: Long, b: Long, prefix: Int): Boolean {
        if (prefix <= 0) return true
        val mask = (0xFFFFFFFFL shl (32 - prefix.coerceAtMost(32))) and 0xFFFFFFFFL
        return (a and mask) == (b and mask)
    }

    /** "192.168.0.10" → número; null se não for um IPv4 literal válido. */
    fun parseIpv4(host: String): Long? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        var value = 0L
        for (p in parts) {
            if (p.isEmpty() || p.length > 3 || !p.all(Char::isDigit)) return null
            val n = p.toInt()
            if (n > 255) return null
            value = (value shl 8) or n.toLong()
        }
        return value
    }

    /** Endereços privados (RFC 1918), onde fica o PC do bar. */
    fun isPrivateIpv4(host: String?): Boolean {
        val ip = host?.let(::parseIpv4) ?: return false
        val a = ip ushr 24
        val b = (ip ushr 16) and 0xFF
        return a == 10L || (a == 192L && b == 168L) || (a == 172L && b in 16L..31L)
    }

    fun format(ip: Long): String =
        "${(ip ushr 24) and 0xFF}.${(ip ushr 16) and 0xFF}.${(ip ushr 8) and 0xFF}.${ip and 0xFF}"

    private fun toLong(bytes: ByteArray): Long =
        bytes.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xFF) }
}
