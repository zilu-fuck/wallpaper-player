# Wallpaper Player

Wallpaper Player is a local video wallpaper gallery/player built with Electron, Vite, and React. It scans local directories, groups video files, generates thumbnails with FFmpeg, and plays videos with either the built-in HTML5 player or bundled mpv.

The Windows release includes mpv and FFmpeg, so users do not need to install them separately.

## Features

- Browse local video folders in a gallery or list view.
- Search by video name or group.
- Sort by name, date, size, or file type.
- Generate video thumbnails with bundled FFmpeg.
- Play almost any common video format with bundled mpv.
- Fall back to the HTML5 video player when needed.
- Manage multiple video directories from the sidebar.
- Dark/light theme support.
- Open a selected video in File Explorer.
- Windows installer and portable exe builds.

## Supported Video Formats

Wallpaper Player scans common video formats including:

`.mp4`, `.webm`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.m4v`, `.mpg`, `.mpeg`, `.3gp`, `.ogv`, `.ts`, `.vob`, `.rmvb`, `.rm`, `.asf`, `.divx`, `.f4v`.

## Download

Windows builds are published on the GitHub Releases page:

https://github.com/zilu-fuck/wallpaper-player/releases

Release artifacts:

- `Wallpaper Player Setup 1.0.0.exe`: installer.
- `Wallpaper Player 1.0.0.exe`: portable executable.

Both builds include:

- mpv at `resources/vendor/mpv/mpv.exe`
- FFmpeg at `resources/vendor/ffmpeg/bin/ffmpeg.exe`

## Development Requirements

- Windows 10 or later
- Node.js 20 or later recommended
- npm

Install dependencies:

```bash
npm install
```

Run Vite for frontend development:

```bash
npm run dev
```

Run the Electron app from a production build:

```bash
npm start
```

## Build Commands

Build the frontend:

```bash
npm run build
```

Download and prepare bundled mpv/FFmpeg into `vendor/`:

```bash
npm run prepare-vendor
```

Create an unpacked Windows app for quick local testing:

```bash
npm run pack:win
```

Create Windows installer and portable exe:

```bash
npm run dist:win
```

The final files are written to `release/`.

## Why `dist:win` Uses A Temporary Build Directory

The project path may contain non-ASCII characters. Some NSIS/7-Zip steps used by Electron Builder can fail when paths are decoded incorrectly. `scripts/package-win.js` copies the prepared project to an ASCII-only temporary directory, runs Electron Builder there, and copies the generated `release/` directory back.

## Bundled Runtime Assets

`scripts/prepare-vendor.js` downloads:

- mpv from the official mpv GitHub release.
- FFmpeg Windows essentials build from gyan.dev.

The downloaded/extracted files are stored under `vendor/`, which is ignored by git because these are large binary assets. They are copied into packaged apps through Electron Builder `extraResources`.

## Security Notes

The app uses Electron context isolation and keeps Node integration disabled in the renderer. File-related IPC handlers validate that video operations stay inside user-approved video directories. The app also restricts its content security policy and avoids broad renderer filesystem access.

## Repository Layout

```text
.
├── main.js                  # Electron main process and IPC
├── mpv.js                   # mpv process manager
├── preload.js               # Safe renderer bridge
├── src/                     # React UI
├── scripts/
│   ├── prepare-vendor.js    # Download/extract mpv and FFmpeg
│   └── package-win.js       # Build from ASCII temp path
├── dist/                    # Vite build output, ignored
├── vendor/                  # Bundled mpv/FFmpeg, ignored
└── release/                 # Packaged Windows artifacts, ignored
```

## License

MIT. See [LICENSE](./LICENSE).
