# Wallpaper Player 1.2.1 测试版发布说明

本文档记录 `2026-06-21` 这一批局域网播放测试版的版本、产物、安装流程、验收重点和已知限制。

## 版本矩阵

| 端 | 版本 | 说明 |
| --- | --- | --- |
| Windows 电脑端 | `1.2.1` | 提供本地视频库、远程访问服务、扫码绑定、缩略图、电脑端播放控制 |
| Android 手机端 | `0.1.0` | 独立 APK，不依赖 Expo Go，用于局域网浏览和播放电脑视频 |

## 本地发布产物

| 文件 | 用途 |
| --- | --- |
| `release/Wallpaper-Player-Setup-1.2.1.exe` | Windows 安装包，推荐普通测试者使用 |
| `release/Wallpaper-Player-1.2.1.exe` | Windows 便携版，适合快速测试 |
| `release/latest.yml` | Windows 自动更新元数据，指向 `1.2.1` 安装包 |
| `mobile/dist/wallpaper-player-mobile-0.1.0-arm64-release.apk` | Android 真机安装包，适合常见 64 位 Android 手机 |

如果测试者无法访问 GitHub，可以直接把上面 3 个主要安装文件通过网盘、局域网共享或聊天工具发送。Windows 端安装包和 APK 不要求测试者安装 Node.js、Expo、mpv 或 FFmpeg。

## 安装顺序

1. 在电脑上安装或运行 `Wallpaper-Player-Setup-1.2.1.exe` / `Wallpaper-Player-1.2.1.exe`。
2. 打开电脑端，添加至少一个视频目录。
3. 在电脑端设置中打开手机访问功能。
4. 在 Android 手机上安装 `wallpaper-player-mobile-0.1.0-arm64-release.apk`。
5. 确保手机和电脑在同一局域网内。
6. 手机端使用扫码绑定或绑定码连接电脑。
7. 进入手机端视频库，打开视频进行上下滑动播放测试。

## 局域网连接流程

1. 电脑端启动远程服务后，会展示局域网地址和一次性绑定二维码。
2. 手机端进入绑定页，扫描二维码或粘贴绑定码。
3. 绑定成功后，手机端保存设备信息，后续可直接进入设备列表。
4. 手机端视频库从电脑端读取目录、标签、收藏、缩略图和视频播放地址。
5. 点击“在电脑端播放”时，电脑使用本地播放器播放当前视频，不是手机投屏。

## 重点验收项

- 电脑端设置页能显示当前版本 `1.2.1`。
- 手机端设置页能显示当前版本 `0.1.0`。
- 手机端可以扫码或输入绑定码完成绑定。
- 手机端视频库能显示两列缩略图、目录分类、标签、收藏和搜索。
- 手机端播放器是沉浸式竖向视频流，每个视频占满一屏。
- 上下滑动一次最多切换一个视频。
- 点击视频暂停/继续，双击收藏，长按左右区域临时 2 倍速快退/快进。
- 横屏全屏退出按钮能真正返回竖屏 feed。
- 电脑端播放按钮能在电脑上显示视频画面和声音。
- 非 MP4/H.264/AAC 等手机不稳定支持格式能显示友好的错误或转码入口。

## 已知限制

- Android APK 当前是 `arm64-v8a` release 测试包，覆盖绝大多数 Android 真机；如果要兼容 x86 模拟器或老设备，需要另打全 ABI 包。
- APK 当前使用 debug keystore 签名的 release 构建，适合内部测试，不适合作为应用商店正式包。
- iOS 还没有打包产物，当前只交付 Android APK。
- 移动端视频直播放依赖系统原生解码能力，MP4/H.264/AAC 最稳定。
- 电脑端自动更新元数据已生成，但实际更新体验取决于发布文件托管位置和网络可达性。
- 长时间低内存压力、更多机型、弱网环境还需要按 `docs/mobile-real-device-qa.md` 做真机验收。

## 构建命令

电脑端 Windows 包：

```powershell
npm run dist:win
```

Android APK 本地构建时建议使用纯 ASCII 路径，避免 Expo/Gradle 在中文路径下解析失败。本次 APK 使用临时目录 `C:\wp-mobile-apk-build` 构建，并输出到 `mobile/dist/`。

常用校验命令：

```powershell
npm run verify:mobile-lan
npm run verify:remote-library
cd mobile
npm run typecheck
```

## 发布清单

发布或发给测试者时建议至少包含：

- `Wallpaper-Player-Setup-1.2.1.exe`
- `Wallpaper-Player-1.2.1.exe`
- `wallpaper-player-mobile-0.1.0-arm64-release.apk`
- 本文档或 README 中的安装流程链接

