package net.oxog.phonebox.deskpanel

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * Connection to the PhoneBox agent on the PC.
 *
 * 1. USB: http://127.0.0.1:8765, tunnelled by "adb reverse" while the cable is plugged in.
 * 2. Wi-Fi / Tailscale: https://<pc-address>:<port>. The address list, a token and the SHA-256 fingerprint of the
 *    agent's self-signed certificate are fetched over USB ("pairing") and stored. Only that exact certificate is
 *    trusted (pinning), and every request carries the token.
 */
class AgentLink(context: Context) {

    class Reply(val code: Int, val contentType: String?, val body: InputStream)

    enum class Route { USB, WIFI, NONE }

    @Volatile var route: Route = Route.NONE
        private set

    private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)
    private val appVersion = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    private val background = Executors.newSingleThreadExecutor()
    private var nextPair = 0L
    @Volatile private var preferredHost = 0
    @Volatile private var factory: Pair<String, SSLSocketFactory>? = null

    /** Opens a long-lived GET (the live stream) over the best route; null when the PC is unreachable. */
    fun stream(path: String): Pair<Route, Reply>? {
        usb("GET", path, STREAM_READ_TIMEOUT)?.let {
            route = Route.USB
            if (it.code == 200) maybePair()
            return Route.USB to it
        }
        wifi("GET", path, STREAM_READ_TIMEOUT)?.let { route = Route.WIFI; return Route.WIFI to it }
        return null
    }

    /** Check for an authenticated USB tunnel without interrupting the current Wi-Fi stream. */
    fun hasUsb(): Boolean = usb("GET", "/api/state", 400)?.let { reply ->
        reply.body.use { reply.code == 200 }
    } ?: false

    /**
     * False only when the agent rejects our Wi-Fi key (401/403), e.g. after "New key" in Settings.
     * Network errors count as authorized so a brief hiccup does not tear down a working stream.
     */
    fun wifiAuthorized(): Boolean = wifi("GET", "/api/state", 2000)?.let { reply ->
        reply.body.use { reply.code != 401 && reply.code != 403 }
    } ?: true

    /** Forwards a request (method + path with query) to the agent over the best available route. */
    fun request(method: String, pathAndQuery: String): Reply {
        usb(method, pathAndQuery)?.let {
            route = Route.USB
            maybePair()
            return it
        }
        wifi(method, pathAndQuery)?.let {
            route = Route.WIFI
            return it
        }
        route = Route.NONE
        return Reply(503, "application/json", ByteArrayInputStream("""{"error":"offline"}""".toByteArray()))
    }

    private fun usb(method: String, pathAndQuery: String, readTimeout: Int = 4000): Reply? = try {
        val c = URL("$USB_BASE$pathAndQuery").openConnection() as HttpURLConnection
        usbAuth(c)
        c.connectTimeout = 400 // refused instantly when no adb reverse tunnel exists
        // 401/403 = tunnel up but our USB key is stale; treat USB as unusable so Wi-Fi can still serve the panel
        send(c, method, readTimeout).takeIf { it.code != 401 && it.code != 403 } ?: run { c.disconnect(); null }
    } catch (e: Exception) {
        null
    }

    private fun wifi(method: String, pathAndQuery: String, readTimeout: Int = 4000): Reply? {
        if (!prefs.getBoolean("enabled", false)) return null
        val hosts = prefs.getString("hosts", "")!!.split(',').filter { it.isNotBlank() }
        val token = prefs.getString("token", null) ?: return null
        val pin = prefs.getString("fingerprint", null) ?: return null
        val port = prefs.getInt("port", 8766)
        if (hosts.isEmpty()) return null
        // Reuse one socket factory per pinned certificate so HTTPS connections are kept alive between requests.
        val f = factory?.takeIf { it.first == pin }?.second ?: pinnedFactory(pin).also { factory = pin to it }
        // Start with the address that worked last time.
        val order = hosts.indices.sortedBy { if (it == preferredHost) -1 else it }
        for (i in order) {
            try {
                val c = URL("https://${hosts[i]}:$port$pathAndQuery").openConnection() as HttpsURLConnection
                c.sslSocketFactory = f
                c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true } // identity is the pinned certificate
                c.connectTimeout = 1500
                c.setRequestProperty("Authorization", "Bearer $token")
                val r = send(c, method, readTimeout)
                preferredHost = i
                return r
            } catch (e: Exception) {
                // try the next address
            }
        }
        return null
    }

    private fun send(c: HttpURLConnection, method: String, readTimeout: Int = 4000): Reply {
        c.requestMethod = method
        c.setRequestProperty("X-PhoneBox-App", appVersion) // lets the agent offer updates
        c.readTimeout = readTimeout
        c.useCaches = false
        if (method == "POST") {
            c.doOutput = true
            c.setFixedLengthStreamingMode(0)
            c.outputStream.close()
        }
        val code = c.responseCode
        val body = (if (code >= 400) c.errorStream else c.inputStream) ?: ByteArrayInputStream(ByteArray(0))
        return Reply(code, c.contentType, body)
    }

    /** While on USB, refresh the Wi-Fi pairing data about once a minute. */
    @Synchronized
    private fun maybePair() {
        val now = SystemClock.elapsedRealtime()
        if (now < nextPair) return
        nextPair = now + 60_000
        background.execute {
            try {
                val c = URL("$USB_BASE/api/pair").openConnection() as HttpURLConnection
                usbAuth(c)
                c.connectTimeout = 800
                c.readTimeout = 3000
                val j = try { JSONObject(c.inputStream.bufferedReader().use { it.readText() }) }
                finally { c.disconnect() }
                val e = prefs.edit()
                if (j.optBoolean("enabled")) {
                    val hosts = j.getJSONArray("hosts")
                    e.putBoolean("enabled", true)
                        .putString("hosts", (0 until hosts.length()).joinToString(",") { hosts.getString(it) })
                        .putInt("port", j.getInt("port"))
                        .putString("token", j.getString("token"))
                        .putString("fingerprint", j.getString("fingerprint"))
                        .putString("pc", j.optString("pc"))
                } else {
                    e.clear()
                }
                e.apply()
            } catch (_: Exception) {
                synchronized(this) { nextPair = SystemClock.elapsedRealtime() + 5_000 }
            }
        }
    }

    private val usbPrefs = context.getSharedPreferences("usb", Context.MODE_PRIVATE)

    /** The agent hands its USB key over adb (intent extra); other apps on the device cannot read it. */
    fun setUsbToken(token: String?) {
        if (!token.isNullOrBlank()) usbPrefs.edit().putString("token", token).apply()
    }

    private fun usbAuth(c: HttpURLConnection) {
        usbPrefs.getString("token", null)?.let { c.setRequestProperty("Authorization", "Bearer $it") }
    }

    fun pairedPc(): String? = if (prefs.getBoolean("enabled", false)) prefs.getString("pc", null) else null

    private fun pinnedFactory(pin: String): SSLSocketFactory {
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException()
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val fp = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded).joinToString("") { "%02x".format(it) }
                if (!fp.equals(pin, ignoreCase = true)) throw CertificateException("certificate does not match the paired PC")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        return SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), SecureRandom()) }.socketFactory
    }

    companion object {
        private const val USB_BASE = "http://127.0.0.1:8765"
        /** The agent sends "state" every second, so a silent connection for this long is dead. */
        private const val STREAM_READ_TIMEOUT = 8000
    }
}
