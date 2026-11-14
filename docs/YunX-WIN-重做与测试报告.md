# YunX WIN 重做与测试报告

## 1. 基线与范围

| 项 | 内容 |
| --- | --- |
| 代码基线 | `tidain/YunX-Desktop` v1.3.4（AGPL-3.0） |
| 安卓上游 | `CYQawa/YunX` |
| 本仓库 | `wumuji/YunX-WIN`（二次创作） |
| 产品版本 | 1.0.0 |
| 目标平台 | Windows 10 / 11 x64 |

本次为**整体换基线重做**：以官方桌面版源码替换原有自研工程，再植入 YunX WIN 品牌与二次创作信息，功能对齐官方全量能力（网盘 / 视频 / GitHub / P2P / 浏览器插件 / 托盘 / 通知 / 内嵌登录 / 备份 / 引擎管理）。

## 2. 本机构建环境

| 项 | 值 |
| --- | --- |
| JDK | 21（便携版 `E:\JAVA21`） |
| Gradle | 8.13（本机缓存，`YUNX_GRADLE_EXE` 注入） |
| C++ 编译器 | MinGW-w64 g++（便携版，用于 `darkmode.dll`） |
| 安装程序 | Inno Setup 6.7.4 |
| 工程路径 | `E:\ai项目\yunx`（含中文） |

## 3. 移植改造清单

1. **工具链**：`jvmToolchain(17)` → 21。
2. **非 ASCII 路径**：`darkmode.cpp` 先复制到系统临时 ASCII 目录编译，再拷回 `build/native/darkmode.dll`。
3. **JRE 模块**：jlink 增加 `jdk.accessibility`，避免部分机器上 `~/.accessibility.properties` 触发 `AWTError` 导致启动失败。
4. **渲染后端**：默认由 OPENGL(ANGLE) 改为 DIRECT3D。实测本机（AMD RX590 + GameViewer 虚拟显示器）OPENGL 下文字正常但所有位图纹理丢失；DIRECT3D 下图片、图标、文字均正常。仍可用 `YUNXPC_RENDER_API` 覆盖。
5. **标题栏图标**：除 Compose `Painter` 外，再用 AWT `setIconImage` 显式设置，避免 WM_SETICON 未生效。
6. **品牌**：产品名 YunX WIN、窗口标题 `YunX WIN - 云析桌面版`、安装包/快捷方式/启动器/扩展名称同步替换。
7. **二次创作信息**：引导页展示 `github.com/wumuji/YunX-WIN` 与 QQ 群 `965943006`；关于页仓库卡片改为“二次创作仓库（木及）”、QQ 卡片改为“QQ 交流群（木及）”。
8. **数据隔离**：数据目录 `.yunx-desktop` → `.yunx-win`，prefs 节点 `yunx` → `yunx-win`，AUMID `YunX.Desktop` → `YunX.WIN`，包名 `YunX-Desktop` → `YunX-WIN`。
9. **更新检测**：仓库指向 `wumuji/YunX-WIN`，无 Release 时按 403 静默失败，不影响使用。
10. **图标**：由 `1.jpg` 生成 512×512 `icon.png` / `about_icon.png` 与多尺寸 `YunX-WIN.ico`，用于窗口、托盘、exe、安装程序与快捷方式。
11. **安装脚本**：`installer/YunX-WIN.iss` 新 AppId、`AppName=YunX WIN`、`Publisher=木及`、发布地址指向二次创作仓库；保留官方中文向导流程。
12. **安装脚本健壮性**：嵌套调用 portable 脚本时临时切换 `$ErrorActionPreference`，避免 jlink 的 stderr 被当作终止错误。

## 4. 验证结果

| 编号 | 场景 | 结果 | 说明 |
| --- | --- | --- | --- |
| B-01 | `:desktop:jar` 编译 | 通过 | JDK 21，含 290+ Kotlin 源文件 |
| B-02 | `darkmode.dll` 编译 | 通过 | MinGW g++，45 KB |
| B-03 | 便携版打包 | 通过 | `release\YunX-WIN\`，255.5 MB |
| B-04 | 安装包打包 | 通过 | `release\YunX-WIN-setup-1.0.0.exe`，210.7 MB |
| F-01 | 启动 / 窗口 | 通过 | 标题 `YunX WIN - 云析桌面版`，标题栏图标为 1.jpg |
| F-02 | 首次引导页 | 通过 | 展示二次创作仓库、QQ 群 965943006、`v1.0.0` |
| F-03 | 主界面 | 通过 | 解析 / 下载 / 设置 / 关于 四个入口正常 |
| F-04 | 设置页 | 通过 | 下载线程、存储目录、任务并发、限速、免转存等项正常渲染 |
| F-05 | 安装 | 通过 | 静默安装退出码 0，桌面快捷方式 `YunX WIN.lnk` 创建 |
| F-06 | 安装版启动 | 通过 | 窗口与引导页正常显示 |
| F-07 | 卸载 | 通过 | 退出码 0，程序目录与快捷方式清理干净 |
| F-08 | JCEF 初始化 | 通过 | 启动日志 `JCEF initialized`，登录依赖已就绪 |
| F-09 | 更新检测 | 通过（预期失败） | 无 Release，403 静默处理 |

以下用例需要有效账号或外网资源，留给人工实测：网盘列目录与取链、视频下载/预览、P2P 实际下载速度、115/Pixiv、通知中心进度、浏览器扩展接管。

## 5. 已知问题

1. 工程路径含中文时，不能用系统 `g++` 直接输出到工程目录；本项目已内置 ASCII 临时目录编译再回拷的方案。
2. 本机 OPENGL(ANGLE) 渲染异常，已默认切换 DIRECT3D；个别老显卡可设置 `YUNXPC_RENDER_API=SOFTWARE`。
3. `release/` 下的便携版与安装包为构建产物，不应提交到 Git。
4. 首次使用内嵌浏览器登录需要解压约 120 MB 的 CEF 运行时到 `.yunx-win\cache\jcef-bundle`，首次启动会稍慢。

## 6. 复现构建

```powershell
$env:JAVA_HOME='E:\JAVA21'
$env:GRADLE_USER_HOME='E:\yunx-tc\gradle-home'
$env:YUNX_GRADLE_EXE='E:\yunx-tc\gradle-8.13\bin\gradle.bat'
$env:PATH='E:\yunx-tc\mingw-extract\mingw64\bin;' + $env:PATH
.\installer-package.ps1
```

输出：`release\YunX-WIN-setup-<version>.exe`。
