package com.yunx.app.data.bridge

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import com.yunx.app.APP_VERSION
import com.yunx.app.util.Log
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 浏览器插件 ↔ 云析 的本地回环 HTTP 桥（IDM 同款思路，无需 native messaging 注册表）。
 *
 * 扩展在 `127.0.0.1` 上按端口区间逐个 `/ping` 探测，命中后拿到本次进程的随机 token；
 * 之后每次劫持下载都 POST `/hook`（带 token），服务端把请求挂起进 [BrowserBridge] 等用户在弹窗里决定，
 * 决定后把结果原路返回，扩展据此「交给云析下载」或「归还浏览器下载」。
 *
 * 安全：只监听回环地址；`/ping` 的 CORS 只放行 `chrome-extension://` / `moz-extension://` 来源，
 * 网页脚本读不到响应体（且自定义头 token 会触发 preflight），因此网页无法伪造劫持请求。
 */
object BrowserBridgeServer {

    private const val TAG = "YunX-Bridge"

    /** 端口区间：先试 37021，被占用则 +1 直到 37030（扩展按同一区间扫描） */
    private const val PORT_START = 37021
    private const val PORT_END = 37030

    /** 单次劫持「等待用户决定」的最长时间；超时按「归还浏览器下载」处理 */
    private const val HOOK_TIMEOUT_MS = 120_000L

    private var server: HttpServer? = null

    /** 实际监听的端口（未启动为 0） */
    @Volatile
    var port: Int = 0
        private set

    /** 本次进程的随机访问令牌（扩展从 /ping 获取） */
    private val token: String = randomToken()

    private val started = AtomicBoolean(false)

    val isRunning: Boolean get() = server != null

    private fun randomToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /** 启动桥接服务（幂等；已在运行则直接返回） */
    fun start() {
        if (!started.compareAndSet(false, true)) return
        var bound: HttpServer? = null
        var boundPort = 0
        for (p in PORT_START..PORT_END) {
            bound = runCatching {
                HttpServer.create(InetSocketAddress("127.0.0.1", p), 0).also { createContexts(it) }
            }.getOrNull()
            if (bound != null) {
                boundPort = p
                break
            }
        }
        if (bound == null) {
            started.set(false)
            Log.w(TAG, "端口 $PORT_START-$PORT_END 全部被占用，浏览器插件桥未启动")
            return
        }
        bound.executor = Executors.newFixedThreadPool(8) { r ->
            Thread(r, "yunx-bridge").apply { isDaemon = true }
        }
        bound.start()
        server = bound
        port = boundPort
        Log.i(TAG, "浏览器插件桥已启动: http://127.0.0.1:$boundPort")
    }

    /** 停止桥接服务 */
    fun stop() {
        val s = server ?: return
        server = null
        port = 0
        started.set(false)
        runCatching { s.stop(0) }
        Log.i(TAG, "浏览器插件桥已停止")
    }

    private fun createContexts(server: HttpServer) {
        server.createContext("/ping", ::handlePing)
        server.createContext("/hook", ::handleHook)
        server.createContext("/bili", ::handleBili)
        server.createContext("/video", ::handleVideo)
        server.createContext("/tasks", ::handleTasks)
        server.createContext("/task/action", ::handleTaskAction)
        server.createContext("/enqueue", ::handleEnqueue)
        server.createContext("/resolve", ::handleResolve)
    }

    // ---------------- 请求处理 ----------------

    private fun handlePing(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            respond(
                ex, 200,
                JSONObject()
                    .put("app", "yunx")
                    .put("mode", "full")
                    .put("api", 2)
                    .put("version", APP_VERSION)
                    .put("token", token)
                    .put(
                        "capabilities",
                        JSONObject()
                            .put("direct", true)
                            .put("hls", true)
                            .put("netdisk", true)
                            .put("video", true)
                            .put("p2p", true)
                            .put("github", true)
                            .put("tasks", true)
                    )
                    .toString()
            )
        } finally {
            ex.close()
        }
    }

    private fun handleHook(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            val body = ex.requestBody.readBytes().toString(StandardCharsets.UTF_8)
            val json = runCatching { JSONObject(body) }.getOrNull()
            if (json == null) {
                respond(ex, 400, """{"error":"bad json"}""")
                return
            }
            val url = json.optString("url").trim()
            if (url.isEmpty()) {
                respond(ex, 400, """{"error":"missing url"}""")
                return
            }
            val req = BrowserBridge.submit(
                url = url,
                fileName = json.optString("fileName").ifBlank { fileNameFromUrl(url) },
                fileSize = json.optLong("fileSize", -1L),
                pageUrl = json.optString("pageUrl"),
                referer = json.optString("referer").ifBlank { json.optString("pageUrl") },
                userAgent = json.optString("userAgent"),
                cookie = json.optString("cookie"),
                mime = json.optString("mime"),
                rootDomain = json.optString("rootDomain")
            )
            Log.i(TAG, "收到劫持请求: ${req.fileName} size=${req.fileSize} host=${req.rootDomain}")
            // 挂起等待用户在弹窗里决定；超时按「归还浏览器下载」处理
            val decision = runBlocking {
                withTimeoutOrNull(HOOK_TIMEOUT_MS) { req.deferred.await() }
            } ?: BrowserBridge.HookDecision.ReturnToBrowser.also { BrowserBridge.timeout(req) }
            respond(ex, 200, decisionJson(decision))
        } catch (e: Exception) {
            Log.w(TAG, "hook 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    /**
     * 扩展「B 站专属页」提交解析下载：`{bvid, pageUrl, qn, mode, title}`。
     *
     * 与 `/hook` 不同，这里**不挂起等用户决定**：清晰度与下载方式都已在插件页选好，
     * 直接把请求转交 UI 层（[BrowserBridge.dispatchBili]）静默入队，立即返回 `{"ok":true}`。
     */
    private fun handleBili(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            val body = ex.requestBody.readBytes().toString(StandardCharsets.UTF_8)
            val json = runCatching { JSONObject(body) }.getOrNull()
            if (json == null) {
                respond(ex, 400, """{"error":"bad json"}""")
                return
            }
            val bvid = json.optString("bvid").trim()
            if (bvid.isEmpty()) {
                respond(ex, 400, """{"error":"missing bvid"}""")
                return
            }
            val req = BrowserBridge.BiliRequest(
                bvid = bvid,
                pageUrl = json.optString("pageUrl"),
                qn = json.optInt("qn", 0),
                mode = json.optString("mode", "merge"),
                title = json.optString("title")
            )
            Log.i(TAG, "收到 B 站下载请求: $bvid qn=${req.qn} mode=${req.mode}")
            val accepted = BrowserBridge.dispatchBili(req)
            respond(ex, 200, JSONObject().put("ok", accepted).toString())
        } catch (e: Exception) {
            Log.w(TAG, "bili 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    /**
     * 扩展「其他视频平台」提交解析下载：`{platform, url, title, pageUrl}`（抖音 / 微博 / AcFun …）。
     *
     * 与 `/bili` 同属**静默入队**：插件读不到这些平台的清晰度档位，只把页面链接交过来，
     * 由 UI 层（[BrowserBridge.dispatchVideo]）解析链接并按平台最高可用档入队，立即返回 `{"ok":true}`。
     */
    private fun handleVideo(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            val body = ex.requestBody.readBytes().toString(StandardCharsets.UTF_8)
            val json = runCatching { JSONObject(body) }.getOrNull()
            if (json == null) {
                respond(ex, 400, """{"error":"bad json"}""")
                return
            }
            val url = json.optString("url").trim()
            if (url.isEmpty()) {
                respond(ex, 400, """{"error":"missing url"}""")
                return
            }
            val req = BrowserBridge.VideoRequest(
                platform = json.optString("platform"),
                url = url,
                title = json.optString("title"),
                pageUrl = json.optString("pageUrl")
            )
            Log.i(TAG, "收到视频下载请求: platform=${req.platform} url=$url")
            val accepted = BrowserBridge.dispatchVideo(req)
            respond(ex, 200, JSONObject().put("ok", accepted).toString())
        } catch (e: Exception) {
            Log.w(TAG, "video 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    /** GET /tasks：扩展下载中心读取完整版任务快照 */
    private fun handleTasks(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("GET", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            if (BridgeTaskController.snapshotProvider == null) {
                respond(ex, 503, """{"ok":false,"error":"ui-not-ready"}""")
                return
            }
            val array = JSONArray()
            BridgeTaskController.snapshot().forEach { array.put(it.toJson()) }
            respond(
                ex, 200,
                JSONObject()
                    .put("ok", true)
                    .put("mode", "full")
                    .put("tasks", array)
                    .toString()
            )
        } catch (e: Exception) {
            Log.w(TAG, "tasks 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    /** POST /task/action：暂停 / 继续 / 重试 / 删除 / 打开 / 所在文件夹 */
    private fun handleTaskAction(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            val json = runCatching {
                JSONObject(ex.requestBody.readBytes().toString(StandardCharsets.UTF_8))
            }.getOrNull()
            if (json == null) {
                respond(ex, 400, """{"ok":false,"error":"bad json"}""")
                return
            }
            val id = json.optLong("id", 0L)
            val action = json.optString("action").trim()
            if (id <= 0L || action.isEmpty()) {
                respond(ex, 400, """{"ok":false,"error":"missing id/action"}""")
                return
            }
            if (BridgeTaskController.actionHandler == null) {
                respond(ex, 503, """{"ok":false,"error":"ui-not-ready"}""")
                return
            }
            val ok = BridgeTaskController.action(id, action, json.optBoolean("deleteLocal", false))
            respond(ex, 200, JSONObject().put("ok", ok).toString())
        } catch (e: Exception) {
            Log.w(TAG, "task/action 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    /** POST /enqueue：扩展直链静默入队，不再弹完整版确认框 */
    private fun handleEnqueue(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            val json = runCatching {
                JSONObject(ex.requestBody.readBytes().toString(StandardCharsets.UTF_8))
            }.getOrNull()
            if (json == null) {
                respond(ex, 400, """{"ok":false,"error":"bad json"}""")
                return
            }
            val url = json.optString("url").trim()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                respond(ex, 400, """{"ok":false,"code":"UNSUPPORTED","reason":"只支持 HTTP(S) 直链"}""")
                return
            }
            val headers = buildMap {
                val headerObject = json.optJSONObject("headers")
                if (headerObject != null) {
                    val keys = headerObject.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        val value = headerObject.optString(key)
                        if (value.isNotBlank()) put(key, value)
                    }
                }
                if (get("Cookie").isNullOrBlank() && json.optString("cookie").isNotBlank()) {
                    put("Cookie", json.optString("cookie"))
                }
                if (get("Referer").isNullOrBlank()) {
                    val referer = json.optString("referer").ifBlank { json.optString("pageUrl") }
                    if (referer.isNotBlank()) put("Referer", referer)
                }
                if (get("User-Agent").isNullOrBlank() && json.optString("userAgent").isNotBlank()) {
                    put("User-Agent", json.optString("userAgent"))
                }
            }
            val req = BridgeEnqueueRequest(
                url = url,
                fileName = json.optString("fileName").ifBlank { fileNameFromUrl(url) },
                fileSize = json.optLong("fileSize", -1L),
                headers = headers,
                saveDir = json.optString("saveDir"),
                threads = json.optInt("threads", 0),
                platform = json.optString("platform")
            )
            if (BridgeTaskController.enqueueHandler == null) {
                respond(ex, 503, """{"ok":false,"error":"ui-not-ready"}""")
                return
            }
            val ok = BridgeTaskController.enqueue(req)
            respond(ex, if (ok) 200 else 500, JSONObject().put("ok", ok).toString())
        } catch (e: Exception) {
            Log.w(TAG, "enqueue 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    /** POST /resolve：网盘 / GitHub 分享链接转完整版解析页 */
    private fun handleResolve(ex: HttpExchange) {
        try {
            if (!applyCors(ex, json = true)) {
                respond(ex, 403, """{"error":"forbidden origin"}""")
                return
            }
            if (ex.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                respond(ex, 204, "")
                return
            }
            if (!ex.requestMethod.equals("POST", ignoreCase = true)) {
                respond(ex, 405, """{"error":"method not allowed"}""")
                return
            }
            if (!tokenMatches(ex)) {
                respond(ex, 401, """{"error":"bad token"}""")
                return
            }
            val json = runCatching {
                JSONObject(ex.requestBody.readBytes().toString(StandardCharsets.UTF_8))
            }.getOrNull()
            if (json == null) {
                respond(ex, 400, """{"ok":false,"error":"bad json"}""")
                return
            }
            val url = json.optString("url").trim()
            if (url.isEmpty()) {
                respond(ex, 400, """{"ok":false,"error":"missing url"}""")
                return
            }
            val accepted = BrowserBridge.dispatchResolve(
                BrowserBridge.ResolveRequest(url = url, title = json.optString("title"))
            )
            respond(ex, 200, JSONObject().put("ok", accepted).toString())
        } catch (e: Exception) {
            Log.w(TAG, "resolve 处理异常: ${e.javaClass.simpleName}: ${e.message}")
            runCatching { respond(ex, 500, """{"ok":false,"error":"internal"}""") }
        } finally {
            ex.close()
        }
    }

    private fun BridgeTaskDto.toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("name", name)
        .put("url", url)
        .put("size", size)
        .put("downloaded", downloaded)
        .put("status", status)
        .put("speed", speed)
        .put("etaMs", etaMs)
        .put("error", error)
        .put("savePath", savePath)
        .put("createdAt", createdAt)

    private fun decisionJson(decision: BrowserBridge.HookDecision): String = when (decision) {
        is BrowserBridge.HookDecision.Accept -> JSONObject()
            .put("action", "accept")
            .put("saveDir", decision.saveDir)
            .put("threads", decision.threads)
            .toString()
        BrowserBridge.HookDecision.Cancel -> """{"action":"cancel"}"""
        BrowserBridge.HookDecision.ReturnToBrowser -> """{"action":"return"}"""
    }

    // ---------------- 工具 ----------------

    private fun tokenMatches(ex: HttpExchange): Boolean {
        val provided = ex.requestHeaders.getFirst("X-YunX-Token") ?: return false
        return provided == token
    }

    /**
     * 写入 CORS 响应头；仅放行浏览器扩展来源（网页 origin 不匹配 → 浏览器会拦截响应体）。
     * @return 是否放行（false → 调用方直接返回 403）
     */
    private fun applyCors(ex: HttpExchange, json: Boolean): Boolean {
        val origin = ex.requestHeaders.getFirst("Origin")
        val allowOrigin = origin?.takeIf {
            it.startsWith("chrome-extension://", ignoreCase = true) ||
                it.startsWith("moz-extension://", ignoreCase = true)
        }
        if (allowOrigin == null) {
            // 无 Origin（如同一台机器的 curl / 本地程序）也放行：本地程序本就不受 CORS 约束，
            // 真正的防线是 token 校验（见 handleHook）。
            if (origin != null) return false
            if (json) ex.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
            return true
        }
        ex.responseHeaders.add("Access-Control-Allow-Origin", allowOrigin)
        ex.responseHeaders.add("Vary", "Origin")
        ex.responseHeaders.add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        ex.responseHeaders.add("Access-Control-Allow-Headers", "Content-Type, X-YunX-Token")
        ex.responseHeaders.add("Access-Control-Max-Age", "600")
        // Chrome 私有网络访问（PNA）：扩展访问回环地址需要显式允许
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
