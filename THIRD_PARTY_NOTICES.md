# Third-Party Notices

Wallpaper Player is licensed under Apache-2.0. The Windows release also bundles
third-party executable programs that are distributed under their own licenses.
These notices apply to the bundled binaries only and do not change the license
of the Wallpaper Player source code.

## Bundled Programs

| Component | Bundled file(s) | Version | License | Source information |
| --- | --- | --- | --- | --- |
| mpv | `vendor/mpv/` | `v0.41.0-dev-g41f6a6450` from release asset `mpv-v0.41.0-x86_64-pc-windows-msvc.zip` | GPL-2.0-or-later | [sources/mpv-source-information.txt](sources/mpv-source-information.txt) |
| aria2 | `vendor/aria2/` | `1.37.0` from release asset `aria2-1.37.0-win-64bit-build1.zip` | GPL-2.0-or-later | [sources/aria2-source-information.txt](sources/aria2-source-information.txt) |
| yt-dlp | `vendor/yt-dlp/` | `2026.06.09` from release asset `yt-dlp.exe` | The Unlicense | [sources/yt-dlp-source-information.txt](sources/yt-dlp-source-information.txt) |
| FFmpeg | `vendor/ffmpeg/` | `8.1.1-essentials_build-www.gyan.dev` from `ffmpeg-8.1.1-essentials_build.zip` | GPL-3.0 | [sources/ffmpeg-source-information.txt](sources/ffmpeg-source-information.txt) |
| llama.cpp | `vendor/llama.cpp-cuda/`, `vendor/llama.cpp/` fallback | `b9756` from `llama-b9756-bin-win-cuda-13.3-x64.zip`, `cudart-llama-bin-win-cuda-13.3-x64.zip`, and `llama-b9756-bin-win-cpu-x64.zip` | MIT | [sources/llama.cpp-source-information.txt](sources/llama.cpp-source-information.txt) |

## License Texts

- mpv GPL-2.0-or-later text: [licenses/mpv-GPL-2.0-or-later.txt](licenses/mpv-GPL-2.0-or-later.txt)
- aria2 GPL-2.0-or-later text: [licenses/aria2-GPL-2.0-or-later.txt](licenses/aria2-GPL-2.0-or-later.txt)
- yt-dlp Unlicense text: [licenses/yt-dlp-Unlicense.txt](licenses/yt-dlp-Unlicense.txt)
- FFmpeg GPL-3.0 text: [licenses/ffmpeg-GPL-3.0.txt](licenses/ffmpeg-GPL-3.0.txt)
- llama.cpp MIT text: [licenses/llama.cpp-MIT.txt](licenses/llama.cpp-MIT.txt)
- Additional dependency notes: [licenses/dependency-notices.txt](licenses/dependency-notices.txt)

## Modification Status

Wallpaper Player downloads and redistributes the upstream binary archives listed
above without source or binary modifications. The application launches these
programs as separate processes.

## Corresponding Source

The corresponding source information recorded at the time of packaging is in
the `sources/` directory. If the bundled binaries are updated, update the exact
version, download URL, SHA-256 hash, source commit, and source retrieval steps in
these notices before publishing a release.
