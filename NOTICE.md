# NOTICE

YunX WIN（本仓库）是云析桌面版的二次创作发行版，遵循 GNU Affero General Public License v3.0（AGPL-3.0）。

## 版权归属

1. **云析 YunX（Android 上游）**
   - 仓库：https://github.com/CYQawa/YunX
   - 版权：Copyright (C) 2026 CYQawa
   - 协议：AGPL-3.0

2. **云析 YunX-Desktop（Windows 官方桌面版，代码基线 v1.3.4）**
   - 仓库：https://github.com/tidain/YunX-Desktop
   - 版权：Copyright (C) 2026 tidain
   - 协议：AGPL-3.0

3. **YunX WIN（本仓库，Windows 二次创作）**
   - 仓库：https://github.com/wumuji/YunX-WIN
   - 作者：木及
   - QQ 群：965943006
   - 协议：AGPL-3.0

## 修改说明

本仓库以官方桌面版 v1.3.4 为基线，主要修改：

1. 产品名称、图标、窗口标题、安装程序与浏览器扩展名称改为 YunX WIN。
2. 首次启动引导页与关于页展示二次创作仓库、作者与 QQ 群。
3. 数据目录、prefs 节点、AUMID、包名改为 `yunx-win`，与官方桌面版隔离。
4. 更新检测指向 `wumuji/YunX-WIN`。
5. 默认渲染后端改为 DIRECT3D，避免部分显卡下 OPENGL(ANGLE) 丢失位图纹理。
6. Gradle 工具链改为 JDK 21，`darkmode.dll` 编译与打包适配非 ASCII 工程路径。

除上述修改外，网盘 / 视频 / P2P / GitHub 等业务逻辑沿用官方桌面版实现。

## 免责声明

本软件仅供个人学习与研究使用。请遵守各网盘、视频平台的服务条款与当地法律法规，勿用于侵犯版权或商业用途。
