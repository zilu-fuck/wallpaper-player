# Wallpaper Player

Wallpaper Player 是一个本地视频壁纸画廊播放器，电脑端基于 Electron、Vite 和 React，手机端基于 Expo / React Native。电脑端负责扫描本地视频目录、生成缩略图、管理收藏和标签，并通过局域网服务把视频库提供给手机端观看。

Windows 发布包内置 mpv、FFmpeg、aria2 和 yt-dlp，普通用户不需要额外安装播放器、转码工具或下载引擎。Android 端是独立 APK，正式测试时不依赖 Expo Go。

## 下载与发布状态

| 端 | 版本 | 产物 |
| --- | --- | --- |
| Windows 电脑端 | 已发布 v1.5.3，Windows x64；可执行文件未签名 | [下载安装包](https://github.com/zilu-fuck/wallpaper-player/releases/download/v1.5.3/Wallpaper-Player-Setup-1.5.3.exe) · [下载便携版](https://github.com/zilu-fuck/wallpaper-player/releases/download/v1.5.3/Wallpaper-Player-1.5.3.exe) |
| Android 手机端 | 源码版本 0.1.4；正式签名与升级迁移仍待完成 | v1.5.3 不附新的 APK，源码更新不代表原生安装包已更新 |
| 官方插件包 | 与 v1.5.3 桌面包的完整性清单配套 | [发布页中的三个 Plugin ZIP](https://github.com/zilu-fuck/wallpaper-player/releases/tag/v1.5.3)：视频理解、AI 搜索、Agent Bridge |

完整下载、更新清单与插件见 [v1.5.3 发布页](https://github.com/zilu-fuck/wallpaper-player/releases/tag/v1.5.3)，更新说明见 [release-notes/v1.5.3.md](release-notes/v1.5.3.md)。源码及原生交付的验收范围见[交付说明](docs/release-delivery.md)和[重构实施记录](docs/refactor-progress.md)。本地构建目录与索引供开发使用，下载已发布版本无需自行构建。

## 主要功能

- 浏览、搜索、排序本地视频目录。
- “添加资源”拆分为本地资源、网络资源、磁链资源。
- 按目录、标签、收藏组织视频，支持多标签包含/排除筛选和隐藏标签。
- 使用 FFmpeg 生成缩略图。
- 缓存视频时长、分辨率、编码等元数据，并使用扫描索引加快再次打开视频库。
- 使用 mpv 播放常见桌面视频格式。
- 支持网络资源库，可保存视频直链、HLS/DASH、NAS/局域网链接和网页入口。
- 支持网页资源解析、剧集展开、内置网页兜底观看和网络资源编辑/删除。
- 新增下载中心，内置 aria2c，支持 HTTP/HTTPS 下载和 BT 磁链任务。
- 磁链下载支持元数据等待、文件选择、tracker、DHT、PEX、LSD、端口检测和完成后刷新目录。
- 支持检测并拉起本机迅雷，任务由迅雷接管时在应用内保留入口和保存目录。
- 支持深色/亮色主题。
- 支持手机端扫码绑定电脑。
- 手机端可在局域网内浏览电脑视频库。
- 手机端可浏览电脑端保存的网络资源，并通过电脑端代理播放直链、已解析网页视频和 HLS 分片。
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

1. 下载上方 Windows v1.5.3 安装包并安装，或将便携版 EXE 放到可写目录运行。便携版数据保存在 EXE 同级 `Data/`，更新时保留该目录。签名及验收范围见[交付说明](docs/release-delivery.md)。
2. 打开电脑端，通过“添加资源”添加本地目录、网络资源或磁链任务。
3. 如需视频理解、AI 搜索或 Agent Bridge，从 [v1.5.3 发布页](https://github.com/zilu-fuck/wallpaper-player/releases/tag/v1.5.3) 下载对应的 `Wallpaper-Player-Plugin-*.zip`，在电脑端设置的“插件管理”中安装并启用。插件必须与桌面包的完整性清单匹配；旧插件如提示校验失败，请安装本次发布附带的 ZIP。
4. 在电脑端设置中打开手机访问功能。
5. 在 Android 手机上使用已核对包名、签名、版本码和协议兼容性的 APK。v1.5.3 仅发布 Windows 资产，没有新的 Android APK；当前源码的正式包和覆盖升级状态见[交付说明](docs/release-delivery.md)。
6. 确保手机和电脑在同一局域网内。
7. 手机端进入绑定页，扫描电脑端二维码或粘贴绑定码。
8. 绑定完成后进入手机端视频库，选择视频开始播放。

如果电脑开了 VPN 或代理，局域网访问可能受到影响。遇到手机连不上时，先确认电脑端显示的局域网 IP、Windows 防火墙、VPN 代理模式和手机 Wi-Fi 是否一致。

## 开发环境

- Windows 10 或更新版本（当前桌面构建验证为 x64）
- 桌面开发需要 Node.js 22.12 或更新版本；手机工具链使用 Node.js 22.13+（22 系列）、24.3+（24 系列）、26 或 27+，CI 使用 Node.js 24
- npm
- Android APK 本地构建需要 JDK 17 和 Android SDK

安装依赖：

```powershell
npm install
npm run electron:install
cd mobile
npm install
```

桌面运行时固定为 Electron 44.9.0。Electron 42 起不再在 npm 安装阶段下载二进制；首次运行会按需准备，也可先执行上面的 `electron:install`。Electron 44 不再提供 Windows 32 位版本。

桌面前端使用 Vite 8 / React 插件 6。修改 `packages/contracts` 或 `packages/domain` 的源码后，先运行 `npm run build:contracts`，再用 `npm run dev -- --force` 重启开发服务器，刷新共享包的预打包缓存。

手机源码使用 Expo 58.0.19 / React Native 0.88.0 / React 19.3.0。修改依赖后，在 `mobile` 目录执行 `node ../scripts/run-verify.cjs node_modules/expo/bin/cli install --check` 检查 SDK 兼容性，再生成新的原生构建；源码升级不会自动生成新的 APK。原生 QA 与发布验收状态见[实施记录](docs/refactor-progress.md)。

手机 Node 构建工具包含固定版本、npm integrity 和源码摘要的 node-forge 验签与 braces 嵌套深度回补。正常 `npm install` / `npm ci` 会自动应用，`npm start` / `npm run android` 会先检查；使用 `--ignore-scripts` 安装后，先在 `mobile` 运行 `npm run patch:dependencies`，直接使用 Expo CLI 前也要完成该步骤。遇到未知版本或源码摘要时安装会停止，需要重新评估上游差异及验签/嵌套回归。已有开发进程需重新启动才能加载新依赖源码。回补不会改变 npm audit 的版本告警；范围见[依赖治理](docs/dependency-governance.md)。

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

每次成功构建输出到独立的 `release/windows-<版本>-<构建ID>/`，其中包含配套 `plugins/` 和完整性清单。本地成功构建后，输出记录在 `.release/packaging/windows.json` 的 `output` 字段；`mode` 区分完整发行包与 `pack:win` 目录包。这些被 Git 忽略的本地产物和索引不随仓库分发，清理后可能不存在。发布门禁只接受当前版本、提交匹配的完整发行包，不回退到旧产物。

构建先复制到独立纯 ASCII 暂存目录；可通过 `WALLPAPER_PLAYER_BUILD_ROOT` 指定项目目录之外的 ASCII 基目录。旧 `release/` 文件和便携版 `Data` 保留原位。失败时保留暂存现场和旧索引，成功才更新索引；具体路径与清理约束见[交付门禁](docs/release-delivery.md)。

只生成插件包：

```powershell
npm run pack:plugins
```

独立插件构建输出到 `release/plugins-<桌面版本>-<构建ID>/plugins/`，索引为 `.release/packaging/plugins.json`。打包不会改写源码中的官方插件摘要；新 ZIP 需与内嵌同一份摘要的桌面构建配套，开发环境与历史应用不会自动信任新包。`npm run verify:plugin-package` 默认验证最新成功的 Windows 构建及其配套插件。

Android APK 构建建议在较短的纯 ASCII 路径下执行 Expo prebuild 和 Gradle，避免中文路径触发 autolinking JSON 路径转义问题。配置插件会在 Windows 设置 CMake 对象路径上限，让过长的生成文件路径使用哈希目录，避免 Ninja 的 260 字符限制。`mobile/dist/` 是被 Git 忽略的本地 APK 输出目录，不保证已存在；发布下载以对应 Release 的附加资产为准。

发布流程区分桌面独立发布与联合 Android 发布，复用完整 CI，产物齐备后先上传草稿、下载校验再公开。Android 正式身份迁移及版本码递增仍是阻断项；配置、签名状态与本机验证范围见[发布交付门禁](docs/release-delivery.md)。

## 验证命令

```powershell
npm run verify:mobile-lan
npm run verify:remote-library
npm run verify:video-metadata
npm run verify:remote-pressure
npm run verify:electron-api
npm run verify:vendor
npm run verify:plugins
npm run verify:plugin-official
npm run verify:plugin-video
npm run verify:plugin-external
npm run verify:plugin-package
npm run verify:release-gate
npm run verify:mobile-updates
npm run verify:update-context
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
|-- vendor/                  # 内置 mpv / FFmpeg / aria2 / yt-dlp，已忽略
|-- release/                 # Windows 打包产物，已忽略
`-- mobile/dist/             # Android APK 产物，已忽略
```

## 文档

- [桌面端与手机端审查及重构方案](docs/desktop-mobile-review-and-refactor-plan.md)
- [重构实施记录](docs/refactor-progress.md)
- [共享协议与接口边界](docs/protocol-contracts.md)
- [发布交付门禁](docs/release-delivery.md)
- [1.5.3 更新说明](release-notes/v1.5.3.md)
- [移动端和远程访问方案](docs/mobile-client-remote-access-plan.md)
- [1.4.0 更新说明](release-notes/v1.4.0.md)
- [1.3.3 更新说明](release-notes/v1.3.3.md)
- [1.3.1 更新说明](release-notes/v1.3.1.md)
- [1.3.0 更新说明](release-notes/v1.3.0.md)
- [1.3.0 更新记录](docs/dev-log-v1.3.0.md)
- [1.2.5 更新说明](release-notes/v1.2.5.md)
- [1.2.5 更新记录](docs/dev-log-v1.2.5.md)
- [移动端真机 QA 清单](docs/mobile-real-device-qa.md)

## 许可证

项目代码使用 Apache-2.0，详见 [LICENSE](LICENSE)。

Windows 发布包会捆绑 mpv、FFmpeg、aria2 和 yt-dlp。它们适用各自的第三方许可证；二进制声明、许可证正文、哈希和源码信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
