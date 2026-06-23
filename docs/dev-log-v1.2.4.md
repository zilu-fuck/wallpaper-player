# Wallpaper Player 1.2.4 更新记录

记录日期：2026-06-23
桌面端版本：`1.2.4`
发布标签：`v1.2.4`

## 版本定位

`v1.2.4` 是一次 Windows 发布补发版本，目标不是新增用户功能，而是修复 `v1.2.3` 在 GitHub Actions 上重新发布失败的问题。

`v1.2.3` 的视频理解功能依赖本地 `video comprehension/video comprehension` 子项目。这个目录在开发机上存在，但根目录 `.gitignore` 排除了 `video comprehension/`，所以 GitHub Actions checkout 后拿不到运行时源码。`scripts/package-win.js` 会校验 `pyproject.toml`、`video_comprehension/cli.py`、`video_comprehension/config.py` 和 `video_comprehension/pipeline.py`，CI 缺少这些文件时会在 Build 步骤失败。

## 修复内容

### 1. 增加可提交的运行时副本

新增 `main/video-comprehension-runtime`，只放入视频理解运行所需的最小文件集：

- `.env.example`
- `pyproject.toml`
- `uv.lock`
- `README.md`
- `docs`
- `video_comprehension`

没有纳入的内容包括：

- `.env`
- `.venv`
- `models`
- `outputs`
- `tests`
- `__pycache__`
- `.git`
- `.pytest_cache`

这样 CI 可以拿到完整运行时源码，同时不会把本机模型、分析结果、虚拟环境或私有配置打进发布包。

### 2. 调整 Windows 打包脚本

`scripts/package-win.js` 现在会按顺序寻找视频理解运行时：

1. `video comprehension/video comprehension`
2. `main/video-comprehension-runtime`

开发机上如果存在原始子项目，仍然优先使用原始子项目；CI 或干净 checkout 中没有原始子项目时，会使用已提交的 fallback 运行时。

打包脚本会继续把运行时复制到两个位置：

- `main/video-comprehension-runtime`：作为 app 包内 fallback
- `video comprehension/video comprehension`：作为安装目录 resources 下的外部运行时

### 3. 提升版本号

版本号从 `1.2.3` 提升到 `1.2.4`。最初考虑过使用 `1.2.3.1` 作为补发版本名，但 npm/electron-builder 需要标准 semver，`1.2.3.1` 不是合法包版本。最终使用 `1.2.4`，保证自动更新也能从 `1.2.3` 正常升级。

## 验证记录

本地已执行：

```powershell
npm.cmd run dist:win
```

验证结果：

- Vite production build 通过。
- vendor 准备步骤通过。
- electron-builder 成功生成 Windows 安装包和便携版。
- `release/Wallpaper-Player-Setup-1.2.4.exe` 已生成。
- `release/Wallpaper-Player-Setup-1.2.4.exe.blockmap` 已生成。
- `release/Wallpaper-Player-1.2.4.exe` 已生成。
- `release/latest.yml` 已生成。
- `release/win-unpacked/resources/video comprehension/video comprehension/pyproject.toml` 存在。
- `release/win-unpacked/resources/video comprehension/video comprehension/video_comprehension/cli.py` 存在。
- `release/win-unpacked/resources/video comprehension/video comprehension/video_comprehension/config.py` 存在。
- `release/win-unpacked/resources/video comprehension/video comprehension/video_comprehension/pipeline.py` 存在。

## 发布步骤

当前环境 `.git` 目录只读，无法完成 `git add`、commit、tag 和 push。获得 Git 写权限后执行：

```powershell
git add package.json package-lock.json scripts/package-win.js release-notes/v1.2.4.md docs/dev-log-v1.2.4.md main/video-comprehension-runtime
git commit -m "fix: release Windows 1.2.4 runtime packaging"
git tag v1.2.4
git push origin master
git push origin v1.2.4
```

不要把本地 `settings.json` 一起提交。

## 风险和注意事项

- `main/video-comprehension-runtime` 是运行时副本，后续如果继续修改 `video comprehension` 子项目，需要同步更新这个 fallback 目录。
- 发布包仍然不包含大模型文件，用户需要在设置页下载、检测或配置本地 VLM 模型。
- 本次只修复 Windows 发布链路，不涉及 Android APK 补发。
