# YunX Fetch（云析下载扩展）

YunX Fetch 是面向 Edge / Chrome 的 Manifest V3 下载扩展：接管浏览器下载，提供独立的下载中心，并连接 **YunX Mini** 精简引擎与 **YunX 完整版**。

## 角色

| 角色 | 说明 |
| --- | --- |
| **YunX Fetch** | 本扩展：下载接管、下载中心、资源嗅探、站点规则、任务聚合 |
| **YunX Mini** | `YunX-WIN.exe --mini`：无界面多线程下载引擎，低占用，空闲自动退出 |
| **YunX 完整版** | 现有桌面程序：网盘分享、视频平台、HLS、P2P、GitHub 等 Mini 不支持的链路 |

## 功能

- **接管浏览器下载**：浏览器开始下载时暂停原下载，按路由交给 Mini / 完整版；必要时回退浏览器引擎。
- **页面内下载气泡**：接管成功即在页面右上角弹出与 Edge 原生气泡同位置、同交互的卡片（进度 / 速度 / 暂停 / 删除），点击空白处或 Esc 关闭；无法注入的页面（`edge://`、PDF 查看器等）自动回退到独立小窗。
- **工具栏弹窗**：点击扩展图标直接打开，分「下载中心 / 资源嗅探」两页，默认展示下载中心；顶部只有设置入口（跳转下载中心设置页）与完整页面入口，不放任何配置项。
- **下载中心**：全页任务列表，支持进度、速度、剩余时间、暂停/继续、失败重试、删除、打开文件、所在文件夹、复制链接、批量操作、筛选、搜索、清除已完成；任务行提供 **交给浏览器 / 交给 YunX Mini / 交给 YunX 完整版** 三个转交操作。
- **删除策略可配置**：设置里可决定「删除任务时是否同时删除本地文件」，删除前会按当前策略提示，批量删除与清除已完成共用同一开关。
- **多线程与限速**：直链交给 YunX Mini 后使用分片并发、断点续传、全局限速、任务并发与失败重试；参数可在下载中心修改。
- **自动唤醒**：Mini 未运行时可经 native messaging 自动拉起；Mini 不支持的链接（HLS / 网盘 / 视频 / P2P）自动转完整版。
- **资源嗅探**：`webRequest` 只读观察响应头 + 页面 DOM 扫描，列出当前页可下载资源。
- **站点规则**：按根域名设置「接管 / 放行」；「本次交给浏览器」后 5 分钟冷却。
- **低占用**：后台无持续轮询；仅在有 Mini / 完整版活动任务时启用 1 分钟闹钟；下载中心隐藏时停止刷新。

## 运行方式

```
YunX Fetch ──GET /ping──▶ 127.0.0.1:37021-37030   YunX 完整版
YunX Fetch ──GET /ping──▶ 127.0.0.1:37031-37040   YunX Mini
YunX Fetch ──POST /enqueue / /task/action / /tasks / /resolve──▶ 对应引擎
YunX Fetch ──sendNativeMessage──▶ com.yunx.mini（按需启动 Mini / 完整版）
```

- 所有服务只监听 `127.0.0.1`，非 `/ping` 请求校验随机 token。
- 未安装 native host 时扩展仍可用，只是不能自动唤醒；可手动启动 `YunX-WIN.exe --mini` 或完整版。
- 扩展无法替换 `edge://downloads` 页面；下载中心通过工具栏按钮、`Ctrl+Shift+Y` 或右键菜单打开。

## 安装

1. Edge 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）。
2. 打开 **开发者模式**，点 **加载已解压的扩展程序**，选择本 `browser-extension` 文件夹。
3. 安装版 YunX 会自动注册 native host；解压版运行一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\browser-extension\native-host\install-native-host.ps1 `
  -AppExe "C:\path\to\YunX-WIN.exe"
```

脚本会编译 `YunX-MiniHost.exe`、写入 Edge/Chrome 注册表键，并把扩展 ID 写入 native host 清单。

## 使用

- **自动**：网页触发下载 → 扩展接管 → 页面内气泡弹出 → Mini（直链）或完整版（分享/视频/HLS/P2P）。
- **手动**：工具栏图标 → 资源列表点「下载」；或右键链接/媒体选择「用 YunX Fetch 下载」。
- **下载中心**：工具栏图标右上角按钮，或 `Ctrl+Shift+Y`。
- **归还**：任务行「交给浏览器」；该站点 5 分钟内不再接管。
- **切换引擎**：下载中心 → 设置 → 路由优先级；可查看 Mini / 完整版连接状态并手动唤醒。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `downloads` | 接管/暂停/重发/管理浏览器下载 |
| `downloads.ui`（可选） | 隐藏扩展发起下载时的 Edge 下载气泡；不支持时功能自动降级 |
| `webRequest` / `<all_urls>` | 只读观察响应头，嗅探可下载资源 |
| `cookies` | 为需要登录态的直链补充 Cookie |
| `nativeMessaging` | 按需唤醒 YunX Mini / 完整版 |
| `notifications` / `alarms` | 完成通知与活动任务期间的低频同步 |

## 文件结构

```
browser-extension/
├── manifest.json
├── EXTENSION_ID                 # 固定扩展 ID，native host 使用
├── src/background/              # 后台模块：接管、路由、桥接、嗅探、任务聚合
├── src/shared/                  # 常量与格式化
├── manager.html/.css/.js        # 下载中心
├── popup.html/.css/.js          # 工具栏弹窗
├── content.js                   # 页面 DOM 资源收集
├── native-host/                 # native messaging host 与注册脚本
└── _locales/ icons/
```

## 隐私

任务元数据与设置仅保存在本机浏览器；下载内容不经过扩展存储；不上传任何数据。
