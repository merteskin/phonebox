package net.oxog.phonebox.deskpanel

import java.io.Closeable
import android.os.SystemClock

/**
 * Keeps one live connection to the agent's /api/stream (server-sent events) and hands every event to [deliver].
 * Reconnects after errors or when an authenticated USB tunnel becomes available during a Wi-Fi session.
 * "open" / "close" pseudo-events tell the panel when to stop or resume its polling fallback.
 */
class AgentStream(private val link: AgentLink, private val deliver: (event: String, data: String) -> Unit) {

    @Volatile private var running = false
    // each start() gets a new generation; a thread from an earlier one (still connecting after a quick pause/resume)
    // sees the change and ends, so there is never more than one stream
    @Volatile private var generation = 0
    @Volatile private var current: Closeable? = null
    private var thread: Thread? = null

    fun start() {
        if (running) return
        running = true
        val gen = ++generation
        thread = Thread({ loop(gen) }, "agent-stream").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        try { current?.close() } catch (_: Exception) {}
        thread?.interrupt()
        thread = null
    }

    private fun loop(gen: Int) {
        val alive = { running && gen == generation }
        while (alive()) {
            var opened = false
            var switchToUsb = false
            var body: Closeable? = null
            try {
                val (route, reply) = link.stream("/api/stream?wave=1") ?: throw java.io.IOException("offline")
                if (reply.code != 200) { reply.body.close(); throw java.io.IOException("HTTP ${reply.code}") }
                if (!alive()) { reply.body.close(); break }
                body = reply.body
                current = body
                opened = true
                deliver("open", "{\"route\":\"${route.name.lowercase()}\"}")
                var nextUsbCheck = SystemClock.elapsedRealtime() + 60_000
                reply.body.bufferedReader(Charsets.UTF_8).use { r ->
                    var event = "message"
                    val data = StringBuilder()
                    while (alive()) {
                        val line = r.readLine() ?: break
                        when {
                            line.isEmpty() -> {
                                if (data.isNotEmpty()) deliver(event, data.toString())
                                event = "message"
                                data.setLength(0)
                                if (route == AgentLink.Route.WIFI && SystemClock.elapsedRealtime() >= nextUsbCheck) {
                                    switchToUsb = link.hasUsb()
                                    if (switchToUsb) break
                                    // The agent checks the key only when a request starts, so re-check it here:
                                    // a revoked key must end this stream, as the old 60 s reconnect did.
                                    if (!link.wifiAuthorized()) break
                                    nextUsbCheck = SystemClock.elapsedRealtime() + 60_000
                                }
                            }
                            line.startsWith("event:") -> event = line.substring(6).trim()
                            line.startsWith("data:") -> data.append(line.substring(5).trimStart())
                        }
                    }
                }
            } catch (_: Exception) {
            } finally {
                if (current === body) current = null // a newer thread may own it already
            }
            if (opened) deliver("close", "{}")
            if (switchToUsb) continue
            if (alive()) try { Thread.sleep(if (opened) 300 else 2000) } catch (_: InterruptedException) {}
        }
    }
}
