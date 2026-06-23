# Wallpaper Player 1.2.5 更新记录

记录日期：2026-06-24
桌面端版本：`1.2.5`
手机端版本：`0.1.3`
发布标签：`v1.2.5`

## 版本定位

`v1.2.5` 是一次工程整理和跨端体验增强版本。目标是让视频库扫描、远程播放、移动端更新和标签筛选进入更稳定的日常使用状态，同时把前一轮变大的组件和远程服务拆开，为后续功能继续扩展留出空间。

## 主要变化

### 1. 视频元数据缓存和扫描索引

新增 `main/video-metadata.js`，用 FFprobe 读取视频时长、分辨率、帧率、编码和容器信息，并把结果缓存到用户数据目录。扫描目录时会优先附带已有缓存，后台再补齐缺失元数据。

目录扫描新增持久化索引。首次完整扫描后，后续启动可以先读取索引快速返回视频列表，再后台刷新目录。索引文件名使用目录路径的 `sha256`，避免 Windows 长路径导致索引文件写入失败。

本轮 review 后修复了一个关键细节：索引命中结果会显式带上 `indexed` / `refreshing` 状态，客户端会自动二次拉取刷新后的完整库，避免把旧索引列表长期当作最终结果。

### 2. 标签、R18 和交集筛选

Wallpaper Engine `project.json` 的系统标签现在会进入视频库。`R18`、`18+`、`adult`、`mature`、`explicit`、`nsfw` 等成人内容标记会统一归一为 `R18` 标签。

桌面端和手机端都支持多标签交集筛选。用户同时勾选多个标签时，列表只展示同时命中所有标签的视频。VLM 分析结果里的标签也可以由用户确认后添加到视频自定义标签里。

### 3. 手机端播放和更新

手机端播放器新增背景设置：默认黑色背景，也可以切换为封面背景。视频库排序改为中文自然排序，并增加标题、文件名、路径/ID 的稳定兜底比较。

手机端绑定电脑前新增更新卡片，显示当前 APK 版本并可检查 GitHub Releases 上的新版；这样手机端不再只能连接电脑后才知道是否需要更新。发布前 review 进一步修正了版本比较逻辑：手机端会从 Release APK 文件名解析 `0.1.x` 版本，不再把桌面端 `v1.2.x` 标签当作手机端版本导致误报。

### 4. 转码队列和缓存管理

远程转码从单次任务扩展为队列和缓存管理。每个视频可按质量生成兼容 MP4，队列中任务会返回排队位置，已完成文件可复用缓存，手机端更多菜单和状态组件也同步展示转码状态。

本轮补充了转码缓存清理接口和并发验证，避免多个手机同时请求不兼容视频时把 FFmpeg 任务打满。发布前 review 还修复了两个队列细节：同一视频同一质量的并发请求会复用同一个任务；源文件更新后，内存中的 ready 任务和旧输出文件会失效并重新转码。

### 5. 组件和远程 handler 拆分

桌面端 `Settings.jsx` 拆出 `src/components/settings/*`，播放器拆出 `src/components/player/*`，保留原有行为但降低单文件体积。

远程服务从一个大 `server.js` 拆成 handler 模块：

- `library`
- `media`
- `tags`
- `analysis`
- `desktop`
- `transcode`
- `info`

公共 JSON 响应、请求体读取、Range 流式传输也拆到 `http-utils.js` 和 `streaming.js`。

### 6. Review 修复

本次发布前对工作区改动做了两轮 review，并修复：

- `settings.json` 本机配置和密钥泄漏风险，已加入 `.gitignore`，不纳入提交。
- 无效 JSON / 超大请求体被当作 500 的问题，改为 400 / 413。
- 删除目录后扫描缓存 watcher 的路径 key 不一致问题。
- 扫描索引旧结果短时间重复返回的问题。
- 扫描索引文件名过长问题。
- 手机端更新检查把桌面端 Release 标签误当作 APK 版本的问题。
- 同一转码 key 并发请求可能启动两个 FFmpeg 任务的问题。
- 源视频更新后仍复用旧转码 ready 缓存的问题。
- 播放器进度缩略图下方浮出时的窗口边界约束。

## 验证记录

发布前执行：

```powershell
npm.cmd run build
npm.cmd run verify:remote-library
npm.cmd run verify:remote-api
npm.cmd run verify:remote-mobile
npm.cmd run verify:mobile-player
npm.cmd run verify:video-metadata
npm.cmd run verify:mobile-transcode
npm.cmd run verify:mobile-transcode-concurrency
npm.cmd run verify:mobile-multi-device
cd mobile
npm.cmd run typecheck
```

## 发布产物

- `release/Wallpaper-Player-Setup-1.2.5.exe`
- `release/Wallpaper-Player-Setup-1.2.5.exe.blockmap`
- `release/Wallpaper-Player-1.2.5.exe`
- `release/latest.yml`
- `release/wallpaper-player-mobile-0.1.3-arm64-release.apk`
- `mobile/dist/wallpaper-player-mobile-0.1.3-arm64-release.apk`

## 注意事项

- Android APK 仍使用 debug keystore 签名，只适合内部测试。
- 转码功能依赖电脑端 FFmpeg，可在发布包内置 vendor 中运行。
- 视频理解仍依赖用户配置模型和 VLM 服务，发布包不会携带大模型文件。
- 手机端更新检查依赖 GitHub Releases 网络可达性。
