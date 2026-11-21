package com.yunx.app

import com.yunx.app.data.db.AppDatabase
import com.yunx.app.data.download.ChunkDownloader
import com.yunx.app.data.download.DownloadManager
import com.yunx.app.data.download.DownloadPlatform
import com.yunx.app.data.network.HttpClients
import com.yunx.app.data.prefs.SettingsRepository
import com.yunx.app.data.bridge.MiniBridgeServer
import com.yunx.app.util.DiagnosticLog
import com.yunx.app.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlin.system.exitProcess

/**
 * YunX Mini：复用完整版下载引擎的无界面精简模式。
 *
 * 目标：
 * - 不初始化 Compose / JCEF / 托盘 / 主窗口，常驻内存显著低于完整版；
 * - 提供 127.0.0.1:37031-37040 的本地 HTTP API，供 YunX Fetch 扩展入队与查看任务；
 * - 仅支持 HTTP(S) 直链（多线程、断点续传、限速、并发、重试）；
 * - 网盘 / 视频 / HLS / P2P 返回 UNSUPPORTED，由扩展自动转完整版；
 * - 空闲超过设置时间后自动退出，下次由 native host 按需唤醒。
 */
fun runMini(args: Array<String>) {
    AppContext.init()
    runCatching { DiagnosticLog.install() }

    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        runCatching { Log.e("YunX-Mini", "未捕获异常（线程 ${thread.name}）", error) }
        runCatching { DiagnosticLog.flush(1000) }
    }

    Log.i("YunX-Mini", "启动 Mini：dataDir=${AppContext.dataDir.absolutePath}")

    val settings = SettingsRepository()
    val database = AppDatabase.get()
    val manager = DownloadManager(
        dao = database.downloadTaskDao(),
        downloader = ChunkDownloader { HttpClients.downloadClient() },
        threadProvider = { platform -> settings.downloadThreadsFor(platform.ifBlank { DownloadPlatform.GENERIC }) },
        saveDirProvider = { settings.downloadDirUri },
        concurrencyProvider = { settings.maxConcurrentDownloads },
        speedLimitProvider = { settings.downloadSpeedLimit },
        retryCountProvider = { settings.downloadRetryCount },
        keepAwakeProvider = { false },
        showSpeedProvider = { false },
        engineEnabledProvider = { false }
    )

    val server = MiniBridgeServer(
        manager = manager,
        settings = settings,
        dao = database.downloadTaskDao()
    )

    if (!server.start()) {
        Log.w("YunX-Mini", "Mini 启动失败或已有实例在运行，退出")
        return
    }

    Runtime.getRuntime().addShutdownHook(
        Thread {
            runCatching { server.stop() }
            runCatching { AppDatabase.checkpointOnExit() }
            runCatching { Log.i("YunX-Mini", "Mini 已退出") }
        }
    )

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    scope.launch {
        while (isActive) {
            delay(30_000L)
            if (server.shouldIdleExit()) {
                Log.i("YunX-Mini", "Mini 空闲超时，自动退出")
                runCatching { server.stop() }
                runCatching { AppDatabase.checkpointOnExit() }
                exitProcess(0)
            }
        }
    }

    if (args.contains("--mini-console")) {
        Log.i("YunX-Mini", "控制台模式：Ctrl+C 退出")
    }

    runBlocking { awaitCancellation() }
}
