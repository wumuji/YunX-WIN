package com.yunx.app.data.bridge

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import com.yunx.app.APP_VERSION
import com.yunx.app.data.db.DownloadTaskDao
import com.yunx.app.data.db.DownloadTaskEntity
import com.yunx.app.data.download.DownloadManager
import com.yunx.app.data.download.DownloadPlatform
import com.yunx.app.data.prefs.SettingsRepository
import com.yunx.app.util.DesktopActions
import com.yunx.app.util.Log
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.system.exitProcess

/**
 * YunX Mini 的本地 HTTP 桥。
 *
 * 与完整版 [BrowserBridgeServer] 保持相同的 CORS / token / JSON 约定，
 * 但端口区间独立（37031-37040），且只暴露精简下载能力。
 */
class MiniBridgeServer(
    private val manager: DownloadManager,
    private val settings: SettingsRepository,
    private val dao: DownloadTaskDao
) {

    companion object {
        private const val TAG = "YunX-Mini-Bridge"
        private const val PORT_START = 37031
        private const val PORT_END = 37040
        private const val API_VERSION = 2
        private val UNSUPPORTED_HOST = Regex(
            "(pan\\.quark\\.cn|drive\\.uc\\.cn|pan\\.xunlei\\.com|pan\\.baidu\\.com|yun\\.139\\.com|" +
                "123(?:865|pan)\\.(?:com|cn)|115(?:cdn|rc)?\\.com|guangyapan\\.com|" +
                "(?:lanzou|lanso|lanzoux|lanzoui)[a-z0-9-]*\\.(?:com|net|org|cn)|" +
                "bilibili\\.com|b23\\.tv|douyin\\.com|iesdouyin\\.com|weibo\\.com|weibo\\.cn|" +
                "acfun\\.cn|xiaohongshu\\.com|xhslink\\.com|kuaishou\\.com|pixiv\\.net|" +
                "youtube\\.com|youtu\\.be)",
            RegexOption.IGNORE_CASE
        )
        private val P2P_SCHEME = Regex("^(magnet:|ed2k:)", RegexOption.IGNORE_CASE)
        private val HLS_PATH = Regex("\\.(m3u8|mpd)([?#]|$)", RegexOption.IGNORE_CASE)
    }

    private val token: String = ByteArray(24).also { SecureRandom().nextBytes(it) }
        .joinToString("") { "%02x".format(it) }

    private val lastActivityAt = AtomicLong(System.currentTimeMillis())
    private var server: HttpServer? = null

    fun start(): Boolean {
        findExistingMiniPort()?.let { port ->
            Log.i(TAG, "已有 Mini 实例在端口 $port，跳过启动")
            return false
        }
        for (port in PORT_START..PORT_END) {
            try {
                val http = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
                http.createContext("/ping", ::handlePing)
                http.createContext("/tasks", ::handleTasks)
                http.createContext("/task/action", ::handleTaskAction)
                http.createContext("/enqueue", ::handleEnqueue)
                http.createContext("/settings", ::handleSettings)
                http.createContext("/shutdown", ::handleShutdown)
                http.executor = Executors.newFixedThreadPool(4) { runnable ->
                    Thread(runnable, "YunX-Mini-Bridge").apply { isDaemon = true }
                }
                http.start()
                server = http
                Log.i(TAG, "Mini 桥已启动：127.0.0.1:$port")
                return true
            } catch (_: Exception) {
                // 端口占用，继续尝试下一个
            }
        }
        Log.w(TAG, "Mini 桥启动失败：37031-37040 均不可用")
        return false
    }

    fun stop() {
        runCatching { server?.stop(0) }
        server = null
    }

    fun shouldIdleExit(): Boolean {
        val minutes = settings.miniIdleMinutes
        if (minutes <= 0) return false
        val tasks = runCatching { runBlocking { dao.observeAll().first() } }.getOrDefault(emptyList())
        val active = tasks.any {
            it.status == DownloadTaskEntity.STATUS_DOWNLOADING ||
                it.status == DownloadTaskEntity.STATUS_PENDING
        }
        if (active) return false
        return System.currentTimeMillis() - lastActivityAt.get() >= minutes * 60_000L
    }

    private fun findExistingMiniPort(): Int? {
        for (port in PORT_START..PORT_END) {
            val text = runCatching {
                val connection = URL("http://127.0.0.1:$port/ping").openConnection() as HttpURLConnection
                connection.connectTimeout = 160
                connection.readTimeout = 160
                connection.requestMethod = "GET"
                try {
                    if (connection.responseCode != 200) return@runCatching null
                    connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                } finally {
                    connection.disconnect()
                }
            }.getOrNull()
            if (text != null && text.contains("\"app\":\"yunx\"") && text.contains("\"mode\":\"mini\"")) {
                return port
            }
        }
        return null
    }

    private fun touch() {
        lastActivityAt.set(System.currentTimeMillis())
    }

    // ---------- 路由 ----------

    private fun handlePing(ex: HttpExchange) {
        touch()
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            respond(
                ex, 200,
                JSONObject()
                    .put("app", "yunx")
                    .put("mode", "mini")
                    .put("api", API_VERSION)
                    .put("version", APP_VERSION)
                    .put("token", token)
                    .put(
                        "capabilities",
                        JSONObject()
                            .put("direct", true)
                            .put("hls", false)
                            .put("netdisk", false)
                            .put("video", false)
                            .put("p2p", false)
                            .put("github", false)
                            .put("tasks", true)
                    )
                    .toString()
            )
        } catch (e: Exception) {
            Log.w(TAG, "ping 处理异常: ${e.message}")
        } finally {
            ex.close()
        }
    }

    private fun handleTasks(ex: HttpExchange) {
        touch()
        try {
            if (!guard(ex)) return
            if (!ex.requestMethod.equals("GET", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            val tasks = runBlocking { dao.observeAll().first() }
            val stats = manager.stats.value
            val array = JSONArray()
            tasks.forEach { task -> array.put(task.toJson(stats[task.id])) }
            respond(
                ex, 200,
                JSONObject()
                    .put("ok", true)
                    .put("mode", "mini")
                    .put("tasks", array)
                    .toString()
            )
        } catch (e: Exception) {
            Log.w(TAG, "tasks 处理异常: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    private fun handleTaskAction(ex: HttpExchange) {
        touch()
        try {
            if (!guard(ex)) return
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            val json = readJson(ex) ?: return
            val id = json.optLong("id", 0L)
            val action = json.optString("action").trim()
            if (id <= 0L || action.isEmpty()) {
                respond(ex, 400, """{"ok":false,"error":"missing id/action"}""")
                return
            }
            val ok = when (action) {
                "pause" -> {
                    manager.pause(id)
                    true
                }
                "resume" -> {
                    manager.start(id)
                    true
                }
                "retry" -> {
                    runBlocking { manager.redownload(id) }
                }
                "remove" -> {
                    manager.remove(id, json.optBoolean("deleteLocal", false))
                    true
                }
                "open" -> {
                    val path = runBlocking { dao.get(id) }?.savePath.orEmpty()
                    path.isNotBlank() && DesktopActions.openFile(path)
                }
                "reveal" -> {
                    val path = runBlocking { dao.get(id) }?.savePath.orEmpty()
                    path.isNotBlank() && DesktopActions.revealFile(path)
                }
                else -> false
            }
            respond(ex, 200, JSONObject().put("ok", ok).toString())
        } catch (e: Exception) {
            Log.w(TAG, "task/action 处理异常: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    private fun handleEnqueue(ex: HttpExchange) {
        touch()
        try {
            if (!guard(ex)) return
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            val json = readJson(ex) ?: return
            val url = json.optString("url").trim()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                respond(ex, 422, unsupported("只支持 HTTP(S) 直链"))
                return
            }
            val host = runCatching { URI(url).host.orEmpty() }.getOrDefault("")
            if (P2P_SCHEME.containsMatchIn(url) || url.contains(".torrent", ignoreCase = true)) {
                respond(ex, 422, unsupported("磁力 / 种子 / ed2k 需要完整版"))
                return
            }
            if (UNSUPPORTED_HOST.containsMatchIn(host)) {
                respond(ex, 422, unsupported("该站点需要完整版解析"))
                return
            }
            if (HLS_PATH.containsMatchIn(url)) {
                respond(ex, 422, unsupported("HLS / DASH 需要完整版"))
                return
            }

            val headers = mutableMapOf<String, String>()
            json.optJSONObject("headers")?.let { headerObject ->
                val keys = headerObject.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = headerObject.optString(key)
                    if (value.isNotBlank()) headers[key] = value
                }
            }
            val fileName = json.optString("fileName").ifBlank { fileNameFromUrl(url) }
            val threads = json.optInt("threads", 0).let {
                if (it > 0) it.coerceIn(1, 512) else settings.downloadThreadsFor(DownloadPlatform.GENERIC)
            }
            val id = runBlocking {
                manager.enqueue(
                    url = url,
                    fileName = fileName,
                    headers = headers,
                    size = json.optLong("fileSize", -1L),
                    platform = DownloadPlatform.GENERIC,
                    saveDir = json.optString("saveDir"),
                    threads = threads
                )
            }
            respond(ex, 200, JSONObject().put("ok", true).put("id", id).toString())
        } catch (e: Exception) {
            Log.w(TAG, "enqueue 处理异常: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"${e.message ?: "internal"}"}""") }
        } finally {
            ex.close()
        }
    }

    private fun handleSettings(ex: HttpExchange) {
        touch()
        try {
            if (!guard(ex)) return
            if (ex.requestMethod.equals("GET", ignoreCase = true)) {
                respond(ex, 200, settingsJson().toString())
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            val json = readJson(ex) ?: return
            if (json.has("threads")) settings.downloadThreads = json.optInt("threads", 32).coerceIn(1, 512)
            if (json.has("concurrency")) {
                settings.maxConcurrentDownloads = json.optInt("concurrency", 3).coerceIn(1, 10)
            }
            if (json.has("speedLimit")) settings.downloadSpeedLimit = json.optLong("speedLimit", 0L).coerceAtLeast(0L)
            if (json.has("retryCount")) settings.downloadRetryCount = json.optInt("retryCount", 3).coerceIn(0, 10)
            if (json.has("idleMinutes")) settings.miniIdleMinutes = json.optInt("idleMinutes", 10)
            if (json.has("saveDir")) {
                val dir = json.optString("saveDir").trim()
                if (dir.isNotEmpty()) {
                    val file = File(dir)
                    if (!file.isAbsolute || (!file.isDirectory && !file.mkdirs())) {
                        respond(ex, 400, """{"ok":false,"error":"保存目录无效"}""")
                        return
                    }
                    settings.downloadDirUri = file.absolutePath
                } else {
                    settings.downloadDirUri = null
                }
            }
            respond(ex, 200, settingsJson().toString())
        } catch (e: Exception) {
            Log.w(TAG, "settings 处理异常: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    private fun handleShutdown(ex: HttpExchange) {
        touch()
        try {
            if (!guard(ex)) return
            respond(ex, 200, """{"ok":true}""")
        } finally {
            ex.close()
        }
        Thread {
            Thread.sleep(150)
            runCatching { stop() }
            exitProcess(0)
        }.apply { isDaemon = true }.start()
    }

    // ---------- 工具 ----------

    private fun guard(ex: HttpExchange): Boolean {
        if (!applyCors(ex, json = true)) {
            respond(ex, 403, """{"error":"forbidden origin"}""")
            return false
        }
        if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
            respond(ex, 204, "")
            return false
        }
        if (!tokenMatches(ex)) {
            respond(ex, 401, """{"error":"bad token"}""")
            return false
        }
        return true
    }

    private fun readJson(ex: HttpExchange): JSONObject? {
        val json = runCatching {
            JSONObject(ex.requestBody.readBytes().toString(StandardCharsets.UTF_8))
        }.getOrNull()
        if (json == null) respond(ex, 400, """{"ok":false,"error":"bad json"}""")
        return json
    }

    private fun settingsJson(): JSONObject = JSONObject()
        .put("ok", true)
        .put("saveDir", settings.downloadDirUri.orEmpty())
        .put("threads", settings.downloadThreadsFor(DownloadPlatform.GENERIC))
        .put("concurrency", settings.maxConcurrentDownloads)
        .put("speedLimit", settings.downloadSpeedLimit)
        .put("retryCount", settings.downloadRetryCount)
        .put("idleMinutes", settings.miniIdleMinutes)

    private fun DownloadTaskEntity.toJson(
        stat: com.yunx.app.data.download.DownloadStats?
    ): JSONObject {
        val status = when (this.status) {
            DownloadTaskEntity.STATUS_PENDING -> "pending"
            DownloadTaskEntity.STATUS_DOWNLOADING -> "downloading"
            DownloadTaskEntity.STATUS_PAUSED -> "paused"
            DownloadTaskEntity.STATUS_COMPLETED -> "completed"
            DownloadTaskEntity.STATUS_FAILED -> "failed"
            else -> "pending"
        }
        return JSONObject()
            .put("id", id)
            .put("name", fileName)
            .put("url", url)
            .put("size", totalSize)
            .put("downloaded", downloadedSize)
            .put("status", status)
            .put("speed", stat?.speed ?: 0L)
            .put("etaMs", stat?.remainMillis?.takeIf { it > 0 } ?: 0L)
            .put("error", errorMsg)
            .put("savePath", savePath)
            .put("createdAt", createTime)
    }

    private fun unsupported(reason: String): String = JSONObject()
        .put("ok", false)
        .put("code", "UNSUPPORTED")
        .put("reason", reason)
        .put("recommend", "full")
        .toString()

    private fun tokenMatches(ex: HttpExchange): Boolean {
        val provided = ex.requestHeaders.getFirst("X-YunX-Token") ?: return false
        return provided == token
    }

    private fun applyCors(ex: HttpExchange, json: Boolean): Boolean {
        val origin = ex.requestHeaders.getFirst("Origin")
        val allowOrigin = origin?.takeIf {
            it.startsWith("chrome-extension://", ignoreCase = true) ||
                it.startsWith("moz-extension://", ignoreCase = true)
        }
        if (allowOrigin == null) {
            if (origin != null) return false
            if (json) ex.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            return true
        }
        ex.responseHeaders.add("Access-Control-Allow-Origin", allowOrigin)
        ex.responseHeaders.add("Vary", "Origin")
        ex.responseHeaders.add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        ex.responseHeaders.add("Access-Control-Allow-Headers", "Content-Type, X-YunX-Token")
        ex.responseHeaders.add("Access-Control-Max-Age", "600")
        ex.responseHeaders.add("Access-Control-Allow-Private-Network", "true")
        if (json) ex.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
        return true
    }

    private fun respond(ex: HttpExchange, code: Int, body: String) {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        if (code == 204) {
            ex.sendResponseHeaders(204, -1)
            return
        }
        ex.sendResponseHeaders(code, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    private fun fileNameFromUrl(url: String): String =
        url.substringAfterLast('/').substringBefore('?').substringBefore('#')
            .ifBlank { "download_${System.currentTimeMillis()}" }
}
