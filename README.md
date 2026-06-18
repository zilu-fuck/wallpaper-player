# Wallpaper Player / 视频壁纸播放器

Wallpaper Player is a local video wallpaper gallery/player built with Electron, Vite, and React. It scans local directories, groups video files, generates thumbnails with FFmpeg, and plays videos with either bundled mpv or the built-in HTML5 player.

Wallpaper Player 是一个基于 Electron、Vite 和 React 的本地视频壁纸画廊/播放器。它可以扫描本地目录、按分组展示视频、使用 FFmpeg 生成缩略图，并通过内置 mpv 或 HTML5 播放器播放视频。

The Windows release includes mpv and FFmpeg, so users do not need to install them separately.

Windows 发布包已内置 mpv 和 FFmpeg，普通用户无需额外安装。

## Current Version / 当前版本

`v1.1.2`

## What's New in v1.1.2 / v1.1.2 更新内容

- Added an in-app update notice with target version, release notes, download progress, and restart-to-install action.
- 新增应用内更新提示，显示目标版本、更新说明、下载进度，并支持下载完成后重启安装。
- Changed installer auto updates from silent downloading to a user-confirmed flow.
- 将安装版自动更新从静默下载改为用户确认下载与安装流程。
- Cached recent directory scan results and invalidated them with file watching plus TTL fallback to reduce repeated scans when switching folders.
- 为近期目录扫描增加缓存，并通过文件监听与 TTL 兜底失效，减少切换目录时的重复扫描。
- Moved the manual update check entry into Settings.
- 将手动检查更新入口移动到设置面板。
- Added a finish-page option in the Windows installer to create a desktop shortcut.
- Windows 安装器完成页新增创建桌面快捷方式选项。
- Improved mpv startup error reporting when the mpv process exits early.
- 改进 mpv 启动失败时的错误提示。
- Release notes for tagged builds are now published from versioned bilingual files.
- tag 发布时会读取版本对应的中英双语更新报告并写入 GitHub Release。

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

Release artifacts for `v1.1.2`:

`v1.1.2` 发布文件：

- `Wallpaper-Player-Setup-1.1.2.exe`: installer / 安装包。
- `Wallpaper-Player-1.1.2.exe`: portable executable / 便携版。

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
|-- main.js                  # Electron main process and IPC / Electron 主进程与 IPC
|-- mpv.js                   # mpv process manager / mpv 进程管理
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

MIT. See [LICENSE](./LICENSE).

MIT。详见 [LICENSE](./LICENSE)。
