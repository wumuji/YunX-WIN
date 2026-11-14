# YunX WIN · 云析桌面版（Windows 二次创作）

> 本仓库是 [云析 YunX-Desktop](https://github.com/tidain/YunX-Desktop)（Windows 官方桌面版，v1.3.4）的二次创作版本，
> 安卓上游为 [CYQawa/YunX](https://github.com/CYQawa/YunX)。
>
> **二次创作仓库**：https://github.com/wumuji/YunX-WIN
> **移植作者**：木及
> **QQ 群**：965943006

云析是一款网盘分享链接解析与高速下载工具：粘贴链接即可解析、浏览目录、多线程下载。

- 网盘：夸克 / UC / 迅雷 / 百度 / 139 / 123 / 115 / 光鸭 / 蓝奏云 / 蓝奏云优享版
- 视频：哔哩哔哩 / 小红书 / 抖音 / 微博 / 快手 / AcFun / Pixiv
- 其他：GitHub 仓库与 Release、磁力 / BT 种子 / ed2k

## 功能

- 分享链接 / 中文口令解析，自动识别提取码
- Range 分片并发 + 断点续传 + 失败重试 + 全局限速 + 分片 SHA-256 校验
- P2P 下载（磁力 / BT / ed2k，Gopeed 引擎）
- 视频解析、在线预览、B 站高清自动合轨
- 多账号与主账号切换；内嵌 Chromium 登录、导入本机浏览器 Cookie、手动 Cookie
- GitHub 仓库树 / Releases / README 渲染 / 镜像测速
- 系统托盘、Windows 通知中心进度、剪贴板链接提示
- 浏览器扩展：资源嗅探与下载接管

## 系统要求

Windows 10 / 11 x64。安装包自带精简 JRE，无需预装 Java。

## 构建

构建脚本与官方桌面版一致：

```powershell
.\run.ps1 run        # 开发运行
.\run.ps1 build      # 仅编译
.\run.ps1 package    # 免安装便携版 → release\YunX-WIN\
.\run.ps1 installer  # 安装程序 → release\YunX-WIN-setup-<版本>.exe
```

本机环境说明：

- JDK 21（官方要求 17；本仓库将 Gradle 工具链调整为 21）
- `darkmode.dll` 需要 C++ 编译器：优先 MSVC，否则回退 MinGW `g++`
- 无法安装编译器时，可跳过该 DLL，仅托盘菜单配色不跟随深色
- 安装包使用 Inno Setup 6

## 数据与缓存

| 内容 | 位置 |
| --- | --- |
| 数据库 / 设置 / 日志 | `%USERPROFILE%\.yunx-win\` |
| JCEF 运行时缓存 | `%USERPROFILE%\.yunx-win\cache\jcef-bundle` |
| 下载目录 | 默认 `%USERPROFILE%\Downloads\YunX`，可在设置中修改 |

## 开源协议

AGPL-3.0。版权与二次创作说明见 [NOTICE.md](NOTICE.md)。
