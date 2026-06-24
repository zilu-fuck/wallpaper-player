# Wallpaper Player 1.3.0 更新记录

记录日期：2026-06-24
桌面端版本：`1.3.0`
手机端版本：`0.1.3`
发布标签：`v1.3.0`

## 版本定位

`v1.3.0` 的目标是把非核心功能从主程序里拆到插件层，同时继续压低视频库页面和播放器的内存压力。核心程序只负责视频库、播放、远程访问、插件框架和受控能力；视频理解、AI 搜索、Agent Bridge 都按插件交付。

## 主要变化

### 1. 插件注册表和生命周期

新增 `main/plugins/registry.js`、`loader.js`、`manifest.js`、`capabilities.js` 等模块。插件可贡献：

- IPC handler
- 远程路由
- 设置默认值和 schema
- 受控 capability
- 启用、停用和 dispose 生命周期

第三方插件默认走声明式能力，不开放任意文件或进程权限。官方插件可通过受控 `ctx.requireCore()` 访问主程序暴露的少量核心模块。

### 2. 视频理解插件化

视频理解相关 IPC、远程路由、VLM 服务、运行时配置和分析结果读取迁到 `video-analysis` 插件。主程序只知道插件贡献了能力，不再直接依赖旧的 `main/video-analysis.js` 和 `main/vlm-service.js`。

本轮 review 后修复了一个关键问题：外置安装后的插件目录不在 `main/plugins` 下，不能继续 `require('../../settings')` 这类相对主程序源码路径。现在视频理解插件通过 registry 注入的 `ctx.requireCore()` 获取受控核心模块。

### 3. 主程序和插件分开打包

Windows 主程序包排除了：

- `main/plugins/video-analysis/**`
- `main/plugins/ai-search/**`
- `main/plugins/agent-bridge/**`
- `main/video-comprehension-runtime/**`
- 视频理解插件独占的 `llama.cpp` / `llama.cpp-cuda`

新增 `scripts/package-plugins.js`，独立输出：

- `release/plugins/Wallpaper-Player-Plugin-video-analysis-1.0.0.zip`
- `release/plugins/Wallpaper-Player-Plugin-ai-search-0.1.0.zip`
- `release/plugins/Wallpaper-Player-Plugin-agent-bridge-0.1.0.zip`

插件管理页支持直接安装目录、`plugin.json` 或 zip 插件包。`verify-plugin-package-install.js` 会真实安装视频理解 zip、启用插件、检查 capability 和远程路由，再卸载插件。

### 4. 插件管理页面

设置页新增“插件管理”页面，和基础设置、手机访问、系统状态并列。插件列表统一显示官方插件和第三方插件，支持启用、停用、安装、卸载和 schema 配置保存。

视频理解的原设置项移动到视频理解插件详情下，避免主设置页继续散落插件功能。

### 5. 性能和内存

桌面端列表分页默认每页 100 个视频。视频卡片缩略图和元数据按可见区域懒加载，播放时主进程暂停普通缩略图队列并降低重复工作。预览帧有独立缓存上限，避免播放器进度预览无限增长。

修复全屏下卡片菜单定位和亮色主题颜色问题；菜单改为 portal + fixed 定位，并挂到 `.app` 下继承主题变量。

### 6. Review 修复

发布前 review 修复：

- 桌面端用旧 `settings.videoAnalysis.enabled` 误判插件可用，导致未安装/未激活时调用未注册 IPC。
- 官方插件实现仍被主程序包打进去，和分离打包目标不一致。
- 插件 zip 安装后返回状态缺少 `installDirectoryName`，UI 无法识别为可卸载插件。
- zip 安装和压缩脚本中的 PowerShell 参数传递问题。
- 视频理解外置后相对主程序源码的 require 失效。

## 验证记录

发布前执行：

```powershell
npm.cmd run build
npm.cmd run verify:plugins
npm.cmd run verify:plugin-official
npm.cmd run verify:plugin-video
npm.cmd run verify:plugin-external
npm.cmd run verify:plugin-package
npm.cmd run verify:plugin-remote
npm.cmd run verify:remote-api
npm.cmd run verify:remote-mobile
npm.cmd run verify:mobile-player
npm.cmd run verify:thumbnail-playback
npm.cmd run verify:video-metadata
cd mobile
npm.cmd run typecheck
```

## 发布产物

- `release/Wallpaper-Player-Setup-1.3.0.exe`
- `release/Wallpaper-Player-Setup-1.3.0.exe.blockmap`
- `release/Wallpaper-Player-1.3.0.exe`
- `release/latest.yml`
- `release/plugins/Wallpaper-Player-Plugin-video-analysis-1.0.0.zip`
- `release/plugins/Wallpaper-Player-Plugin-ai-search-0.1.0.zip`
- `release/plugins/Wallpaper-Player-Plugin-agent-bridge-0.1.0.zip`
- `mobile/dist/wallpaper-player-mobile-0.1.3-arm64-release.apk`

## 注意事项

- 视频理解插件包含运行时代码和本地 VLM 服务程序，不包含大模型文件。
- AI 搜索和 Agent Bridge 当前仍是插件占位，不开放任意文件或进程能力。
- Android APK 仍使用 debug keystore 签名，只适合内部测试。
