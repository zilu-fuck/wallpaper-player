# Wallpaper Player

Wallpaper Player 是一个本地视频壁纸画廊播放器，电脑端基于 Electron、Vite 和 React，手机端基于 Expo / React Native。电脑端负责扫描本地视频目录、生成缩略图、管理收藏和标签，并通过局域网服务把视频库提供给手机端观看。

Windows 发布包内置 mpv 和 FFmpeg，普通用户不需要额外安装播放器或转码工具。Android 端是独立 APK，正式测试时不依赖 Expo Go。

## 当前测试版

| 端 | 版本 | 产物 |
| --- | --- | --- |
| Windows 电脑端 | `1.3.3` | `release/Wallpaper-Player-Setup-1.3.3.exe`、`release/Wallpaper-Player-1.3.3.exe` |
| Android 手机端 | `0.1.3` | `mobile/dist/wallpaper-player-mobile-0.1.3-arm64-release.apk` |
| 插件包 | `video-analysis 1.0.0`、`ai-search 0.1.0`、`agent-bridge 0.1.0` | `release/plugins/*.zip` |

本批更新说明见 [release-notes/v1.3.3.md](release-notes/v1.3.3.md)，开发记录见 [docs/dev-log-v1.3.0.md](docs/dev-log-v1.3.0.md)。

## 主要功能

- 浏览、搜索、排序本地视频目录。
- 按目录、标签、收藏组织视频，支持多标签包含/排除筛选和隐藏标签。
- 使用 FFmpeg 生成缩略图。
- 缓存视频时长、分辨率、编码等元数据，并使用扫描索引加快再次打开视频库。
- 使用 mpv 播放常见桌面视频格式。
- 支持深色/亮色主题。
- 支持手机端扫码绑定电脑。
- 手机端可在局域网内浏览电脑视频库。
- 手机端提供沉浸式上下滑动视频流。
- 手机端支持收藏、标签、缓存占位、电脑端播放、更多菜单和兼容转码。
- 支持电脑端和手机端多选视频后批量添加标签，并可复用已有标签。
- 支持电脑端移除绑定设备和多设备管理基础流程。
- 支持隐私目录，默认从电脑端侧栏和手机端远程库中隐藏。
- 便携版会把设置、缩略图、扫描缓存和手机绑定身份保存到 exe 同级 `Data/` 目录。
- 支持插件管理，插件可贡献 IPC、远程路由、设置 schema 和生命周期。
- 视频理解、AI 搜索、Agent Bridge 以插件形式分发；视频理解插件可在电脑端分析视频，并可在手机端查看分析进度、结果和标签。
- 手机端未连接电脑前也可检查 APK 更新，并可在播放器设置中选择黑色或封面背景。

## 支持的视频格式

电脑端会扫描常见视频格式：

```text
.mp4, .webm, .mkv, .avi, .mov, .wmv, .flv, .m4v, .mpg, .mpeg,
.3gp, .ogv, .ts, .vob, .rmvb, .rm, .asf, .divx, .f4v
```

手机端直播放依赖 Android / iOS 原生解码能力，MP4/H.264/AAC 最稳定。不兼容格式会显示错误或转码入口。

## 安装和绑定

1. 在电脑上安装或运行 `release/Wallpaper-Player-Setup-1.3.3.exe` / `release/Wallpaper-Player-1.3.3.exe`。
2. 打开电脑端，添加视频目录。
3. 如需视频理解、AI 搜索或 Agent Bridge，在电脑端设置的“插件管理”中安装对应 `release/plugins/*.zip` 插件包，再启用插件。
4. 在电脑端设置中打开手机访问功能。
5. 在 Android 手机上安装 `mobile/dist/wallpaper-player-mobile-0.1.3-arm64-release.apk`。
6. 确保手机和电脑在同一局域网内。
7. 手机端进入绑定页，扫描电脑端二维码或粘贴绑定码。
8. 绑定完成后进入手机端视频库，选择视频开始播放。

如果电脑开了 VPN 或代理，局域网访问可能受到影响。遇到手机连不上时，先确认电脑端显示的局域网 IP、Windows 防火墙、VPN 代理模式和手机 Wi-Fi 是否一致。

## 开发环境

- Windows 10 或更新版本
- Node.js 20 或更新版本
- npm
- Android APK 本地构建需要 JDK 17 和 Android SDK

安装依赖：

```powershell
npm install
cd mobile
npm install
```

启动电脑端开发：

```powershell
npm run dev
```

从生产构建运行电脑端：

```powershell
npm start
```

启动手机端开发：

```powershell
cd mobile
npm start
```

## 构建命令

构建电脑端前端：

```powershell
npm run build
```

准备内置 mpv / FFmpeg：

```powershell
npm run prepare-vendor
```

生成 Windows 安装包和便携版：

```powershell
npm run dist:win
```

最终文件会输出到 `release/`，插件包会输出到 `release/plugins/`。`dist:win` 会把项目复制到纯 ASCII 临时目录再打包，用来规避中文路径导致的 Electron Builder / NSIS 路径解析问题。

只生成插件包：

```powershell
npm run pack:plugins
```

Android APK 构建建议在纯 ASCII 路径下执行 Expo prebuild 和 Gradle，避免中文路径触发 autolinking JSON 路径转义问题。当前生成 APK 输出到：

```text
mobile/dist/wallpaper-player-mobile-0.1.3-arm64-release.apk
```

## 验证命令

```powershell
npm run verify:mobile-lan
npm run verify:remote-library
npm run verify:video-metadata
npm run verify:remote-pressure
npm run verify:plugins
npm run verify:plugin-official
npm run verify:plugin-video
npm run verify:plugin-external
npm run verify:plugin-package
cd mobile
npm run typecheck
```

真机验收清单见 [docs/mobile-real-device-qa.md](docs/mobile-real-device-qa.md)。

## 仓库结构

```text
.
|-- main.js                  # Electron 入口
|-- main/                    # 主进程、IPC、远程访问服务
|-- main/plugins/            # 插件注册表、加载器和官方插件源码
|-- main/remote/             # 手机端局域网访问、绑定、转码、视频索引
|-- main/video-comprehension-runtime/  # 视频理解插件依赖的 Python 运行时（uv 管理）
|-- mpv.js                   # mpv 进程和嵌入管理
|-- preload.js               # 安全的渲染进程桥
|-- src/                     # 电脑端 React UI
|-- mobile/                  # React Native 手机端
|-- docs/                    # 方案、发布说明和 QA 文档
|-- scripts/                 # 构建、vendor 准备、验证脚本
|-- dist/                    # 电脑端前端构建输出，已忽略
|-- vendor/                  # 内置 mpv / FFmpeg，已忽略
|-- release/                 # Windows 打包产物，已忽略
`-- mobile/dist/             # Android APK 产物，已忽略
```

## 文档

- [移动端和远程访问方案](docs/mobile-client-remote-access-plan.md)
- [1.3.1 更新说明](release-notes/v1.3.1.md)
- [1.3.0 更新说明](release-notes/v1.3.0.md)
- [1.3.0 更新记录](docs/dev-log-v1.3.0.md)
- [1.2.5 更新说明](release-notes/v1.2.5.md)
- [1.2.5 更新记录](docs/dev-log-v1.2.5.md)
- [移动端真机 QA 清单](docs/mobile-real-device-qa.md)

## 许可证

项目代码使用 Apache-2.0，详见 [LICENSE](LICENSE)。

Windows 发布包会捆绑 mpv 和 FFmpeg，它们适用各自的 GPL 许可证。二进制声明、许可证正文、哈希和源码信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
