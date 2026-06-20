# Wallpaper Player / 视频壁纸播放器

Wallpaper Player is a local video wallpaper gallery/player built with Electron, Vite, and React. It scans local directories, groups video files, generates thumbnails with FFmpeg, and plays videos with either bundled mpv or the built-in HTML5 player.

Wallpaper Player 是一个基于 Electron、Vite 和 React 的本地视频壁纸画廊/播放器。它可以扫描本地目录、按分组展示视频、使用 FFmpeg 生成缩略图，并通过内置 mpv 或 HTML5 播放器播放视频。

The Windows release includes mpv and FFmpeg, so users do not need to install them separately.

Windows 发布包已内置 mpv 和 FFmpeg，普通用户无需额外安装。

## Current Version / 当前版本

`v1.2.0`

## What's New in v1.2.0 / v1.2.0 更新内容

- Rebuilt the player as a modern embedded web-video interface with a 16:9 black stage and compact overlay controls.
- 将播放器重构为现代网页嵌入式视频界面，使用 16:9 黑色播放区域和紧凑的覆盖式控制栏。
- Reworked mpv embedding so the app-managed controls sit over the playback area while mpv's native OSC stays hidden.
- 重做 mpv 嵌入方式，应用自己的控制层直接覆盖在播放区域上，并隐藏 mpv 原生 OSC。
- Added floating menus for speed, subtitles, audio tracks, settings, and quality instead of large controls below the video.
- 倍速、字幕、音轨、设置和清晰度改为小型悬浮菜单，不再占用视频下方的大块表单区域。
- Fixed initial mpv host sizing, web fullscreen layout, and playlist navigation so next/previous stays in the active category.
- 修复 mpv 初始嵌入尺寸、网页全屏布局和播放队列跳转问题，上一首/下一首会保持在当前分类队列内。
- Improved keyboard playback behavior: short arrow press seeks, long arrow press temporarily speeds playback.
- 优化方向键快捷键：短按快进/快退，长按临时倍速播放。
- Added playback-state persistence for position, volume, speed, subtitle, audio track, loop, and A-B loop settings.
- 增加播放状态保存，覆盖进度、音量、倍速、字幕、音轨、循环和 A-B 循环设置。
- Split the Electron main process into smaller modules and tightened IPC command/path validation.
- 将 Electron 主进程拆分为更小的模块，并收紧 IPC 命令和路径校验。

## Features / 功能

- Browse local video folders in a gallery or list view.
- 以画廊视图或列表视图浏览本地视频目录。
- Search by video name, group, or tag.
- 按视频名称、分组或标签搜索。
- Sort by name, date, size, or file type.
- 按名称、日期、大小或文件类型排序。
- Generate video thumbnails with bundled FFmpeg.
- 使用内置 FFmpeg 生成视频缩略图。
- Play almost any common video format with bundled mpv.
- 使用内置 mpv 播放常见视频格式。
- Fall back to the HTML5 video player when needed.
- 必要时回退到 HTML5 播放器。
- Manage multiple video directories from the sidebar.
- 在侧边栏管理多个视频目录。
- Add favorites and custom tags.
- 支持收藏和自定义标签。
- Dark/light theme support.
- 支持深色/亮色主题。
- Open a selected video in File Explorer.
- 在资源管理器中定位选中的视频。
- Windows installer and portable executable builds.
- 提供 Windows 安装包和便携版可执行文件。

## Supported Video Formats / 支持的视频格式

Wallpaper Player scans common video formats including:

Wallpaper Player 会扫描以下常见视频格式：

`.mp4`, `.webm`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.m4v`, `.mpg`, `.mpeg`, `.3gp`, `.ogv`, `.ts`, `.vob`, `.rmvb`, `.rm`, `.asf`, `.divx`, `.f4v`.

## Download / 下载

Windows builds are published on the GitHub Releases page:

Windows 构建产物发布在 GitHub Releases 页面：

https://github.com/zilu-fuck/wallpaper-player/releases

Release artifacts for `v1.2.0`:

`v1.2.0` 发布文件：

- `Wallpaper-Player-Setup-1.2.0.exe`: installer / 安装包。
- `Wallpaper-Player-1.2.0.exe`: portable executable / 便携版。

Both builds include:

两种构建都包含：

- mpv at `resources/vendor/mpv/mpv.exe`
- FFmpeg at `resources/vendor/ffmpeg/bin/ffmpeg.exe`

## Development Requirements / 开发环境

- Windows 10 or later / Windows 10 或更新版本
- Node.js 20 or later recommended / 推荐 Node.js 20 或更新版本
- npm

Install dependencies / 安装依赖：

```bash
npm install
```

Run Vite for frontend development / 启动前端开发服务器：

```bash
npm run dev
```

Run the Electron app from a production build / 使用生产构建运行 Electron 应用：

```bash
npm start
```

## Build Commands / 构建命令

Build the frontend / 构建前端：

```bash
npm run build
```

Download and prepare bundled mpv/FFmpeg into `vendor/` / 下载并准备内置 mpv/FFmpeg 到 `vendor/`：

```bash
npm run prepare-vendor
```

Create an unpacked Windows app for quick local testing / 创建未打包的 Windows 应用用于本地测试：

```bash
npm run pack:win
```

Create Windows installer and portable executable / 创建 Windows 安装包和便携版：

```bash
npm run dist:win
```

The final files are written to `release/`.

最终文件会输出到 `release/`。

## Why `dist:win` Uses a Temporary Build Directory / 为什么 `dist:win` 使用临时构建目录

The project path may contain non-ASCII characters. Some NSIS/7-Zip steps used by Electron Builder can fail when paths are decoded incorrectly. `scripts/package-win.js` copies the prepared project to an ASCII-only temporary directory, runs Electron Builder there, and copies the generated `release/` directory back.

项目路径可能包含非 ASCII 字符。Electron Builder 使用的部分 NSIS/7-Zip 步骤在路径解码异常时可能失败。`scripts/package-win.js` 会将项目复制到纯 ASCII 临时目录中构建，再把生成的 `release/` 目录复制回来。

## Bundled Runtime Assets / 内置运行时资源

`scripts/prepare-vendor.js` downloads:

`scripts/prepare-vendor.js` 会下载：

- mpv from the official mpv GitHub release.
- 来自 mpv 官方 GitHub Release 的 mpv。
- FFmpeg Windows essentials build from gyan.dev.
- 来自 gyan.dev 的 FFmpeg Windows essentials 构建。

The downloaded/extracted files are stored under `vendor/`, which is ignored by git because these are large binary assets. They are copied into packaged apps through Electron Builder `extraResources`.

下载并解压后的文件位于 `vendor/`，由于是大型二进制资源，该目录不会提交到 git。Electron Builder 会通过 `extraResources` 将它们复制进打包应用。

## Security Notes / 安全说明

The app uses Electron context isolation and keeps Node integration disabled in the renderer. File-related IPC handlers validate that video operations stay inside user-approved video directories. The app also restricts its content security policy, denies unexpected navigation/window creation, and avoids broad renderer filesystem access.

应用启用了 Electron context isolation，并在渲染进程中禁用 Node integration。与文件相关的 IPC 会校验视频操作是否位于用户批准的视频目录中。应用还限制了内容安全策略、拒绝非预期导航/新窗口，并避免给渲染进程开放宽泛的文件系统访问能力。

## Repository Layout / 仓库结构

```text
.
|-- main.js                  # Electron entry / Electron 入口
|-- main/                    # Main-process modules and IPC / 主进程模块与 IPC
|-- mpv.js                   # mpv process manager and embedding / mpv 进程与嵌入管理
|-- preload.js               # Safe renderer bridge / 安全渲染进程桥接
|-- src/                     # React UI / React 界面
|-- scripts/
|   |-- prepare-vendor.js    # Download/extract mpv and FFmpeg / 下载并解压 mpv 与 FFmpeg
|   `-- package-win.js       # Build from ASCII temp path / 从 ASCII 临时路径构建
|-- dist/                    # Vite build output, ignored / Vite 构建输出，已忽略
|-- vendor/                  # Bundled mpv/FFmpeg, ignored / 内置 mpv/FFmpeg，已忽略
`-- release/                 # Packaged Windows artifacts, ignored / Windows 打包产物，已忽略
```

## License / 许可证

Apache-2.0. See [LICENSE](./LICENSE).

Apache-2.0。详见 [LICENSE](./LICENSE)。

Windows releases bundle mpv and FFmpeg under their own GPL licenses. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for binary notices,
license texts, hashes, and source information.

Windows 发布包会捆绑 mpv 和 FFmpeg，它们适用各自的 GPL 许可证。二进制声明、
许可证正文、哈希和源码信息详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
