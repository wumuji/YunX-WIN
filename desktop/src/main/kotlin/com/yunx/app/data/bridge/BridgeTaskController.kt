package com.yunx.app.data.bridge

/**
 * 扩展 ↔ 完整版/精简版的「任务管理」桥接控制器。
 *
 * HTTP 层（[BrowserBridgeServer]、[MiniBridgeServer]）只负责协议；
 * UI 层在组合启动时注册具体实现，避免桥接层直接依赖 Compose / ViewModel。
 */
object BridgeTaskController {

    @Volatile
    var snapshotProvider: (() -> List<BridgeTaskDto>)? = null

    /** action: pause / resume / retry / remove / open / reveal */
    @Volatile
    var actionHandler: ((id: Long, action: String, deleteLocal: Boolean) -> Boolean)? = null

    @Volatile
    var enqueueHandler: ((BridgeEnqueueRequest) -> Boolean)? = null

    @Volatile
    var resolveHandler: ((url: String, title: String) -> Boolean)? = null

    fun snapshot(): List<BridgeTaskDto> = snapshotProvider?.invoke().orEmpty()

    fun action(id: Long, action: String, deleteLocal: Boolean): Boolean =
        actionHandler?.invoke(id, action, deleteLocal) ?: false

    fun enqueue(req: BridgeEnqueueRequest): Boolean = enqueueHandler?.invoke(req) ?: false

    fun resolve(url: String, title: String): Boolean = resolveHandler?.invoke(url, title) ?: false

    fun clear() {
        snapshotProvider = null
        actionHandler = null
        enqueueHandler = null
        resolveHandler = null
    }
}

data class BridgeTaskDto(
    val id: Long,
    val name: String,
    val url: String,
    val size: Long,
    val downloaded: Long,
    val status: String,
    val speed: Long,
    val etaMs: Long,
    val error: String,
    val savePath: String,
    val createdAt: Long,
)

data class BridgeEnqueueRequest(
    val url: String,
    val fileName: String,
    val fileSize: Long,
    val headers: Map<String, String>,
    val saveDir: String,
    val threads: Int,
    val platform: String,
)
