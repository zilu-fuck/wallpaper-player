# Wallpaper Player Mobile 真机 QA 验收清单

本文档用于补齐自动化脚本无法证明的真机事项：Android/iOS 安全区域、原生播放器行为、系统横屏、低内存回收、长时间局域网传输和多电脑切换。

## 前置条件

1. 电脑端已安装并能运行 Wallpaper Player。
2. 电脑端已添加至少 2 个视频目录，其中包含：
   - MP4/H.264/AAC 视频 3 个以上。
   - 横屏 16:9 视频 2 个以上。
   - 竖屏 9:16 视频 2 个以上。
   - 非手机原生稳定支持格式至少 1 个，例如 MKV/AVI/WMV。
3. 手机和电脑在同一个局域网。
4. 手机端使用开发构建或安装包，不使用 Expo Go 作为最终验收依据。
5. 开始真机验收前先在电脑端通过：

```bash
npm run verify:mobile-lan
npm run verify:remote-pressure
npm run build
cd mobile && npm run typecheck
```

Android 真机采集可以使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -Scenario playback-60m -DurationMinutes 60 -DesktopBaseUrl http://电脑IP:38127
```

如果 Android platform-tools 已安装但 `adb` 没有加入 PATH，可以显式传入：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -AdbPath "C:\Users\<你>\AppData\Local\Android\Sdk\platform-tools\adb.exe" -DurationMinutes 60 -DesktopBaseUrl http://电脑IP:38127
```

该脚本会把设备信息、内存采样、logcat、电脑端 `/v1/info` 结果和 `performance-budget.json` 保存到 `docs/qa/mobile-real-device/`。它可以自动判断内存增长、最终内存、崩溃日志和桌面端连通性，但不能替代下面的人工通过/失败判断。

常用场景：

```powershell
# 1k 库滚动和播放预算，建议至少 20 分钟
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -Scenario library-1k -LibrarySize 1000 -DurationMinutes 20 -DesktopBaseUrl http://电脑IP:38127

# 5k 库滚动和恢复预算，建议至少 30 分钟
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -Scenario library-5k -LibrarySize 5000 -DurationMinutes 30 -DesktopBaseUrl http://电脑IP:38127

# 低内存恢复预算，脚本会在中段发送 Android trim-memory 信号
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -Scenario low-memory-restore -DurationMinutes 20 -SendTrimMemory -DesktopBaseUrl http://电脑IP:38127

# 弱网重连预算，需要配合路由器限速/断网或系统网络调试工具
powershell -ExecutionPolicy Bypass -File scripts\qa-mobile-real-device.ps1 -Scenario weak-network -DurationMinutes 20 -DesktopBaseUrl http://电脑IP:38127
```

## 性能预算

这些预算用于提前约束移动端改动；不满足时不要把“移动端性能稳定”标为完成。

| 场景 | 最小样本 | 自动预算 | 人工通过标准 |
| --- | --- | --- | --- |
| 1k 视频库 | 1,000 个视频，至少 20 分钟 | `performance-budget.json` 中 `automaticPass=true`；PSS 增长不超过 120 MB，最终 PSS 不超过 900 MB，无崩溃日志 | 首屏可进入，搜索/筛选可用，列表滚动没有持续卡顿，进入播放器不白屏 |
| 5k 视频库 | 5,000 个视频，至少 30 分钟 | 同上；如果低端机超过预算，必须记录型号并降级为待优化 | 搜索、目录切换、标签筛选可以完成；回到播放器后仍只保留单播放器 |
| 60 分钟播放 | 连续播放 60 分钟 | PSS 增长不超过 120 MB，最终 PSS 不超过 900 MB，`/v1/info` 轮询无失败 | 无声音叠加、无黑屏、进度保存正常、横竖屏切换后仍能播放 |
| 低内存恢复 | Android trim-memory 或系统回收后继续播放 | 无崩溃日志；返回前台后最终 PSS 仍在预算内 | 回到前台后能恢复当前视频或显示可重试错误，不出现空 UI |
| 切后台/锁屏 | 锁屏 1 分钟、后台 2 分钟 | 无崩溃日志；桌面端轮询继续可用 | 返回后播放状态符合设置，进度不倒退超过 5 秒 |
| 弱网重连 | 限速/断网/恢复各至少 2 轮 | 无崩溃日志；恢复网络后 `/v1/info` 可重新成功 | UI 有离线/重试反馈，恢复网络后库和播放可继续 |

默认预算可以通过脚本参数调整，例如 `-MaxPssGrowthMb 160 -MaxFinalPssMb 1100`，但调整必须写入记录模板并说明设备原因。

## 设备矩阵

至少覆盖：

| 类型 | 最低要求 |
| --- | --- |
| Android | 1 台中低端设备，内存 4GB 或以下优先 |
| Android | 1 台常用主力设备，全面屏/手势导航 |
| iOS | 1 台刘海屏或灵动岛设备；如暂未打 iOS 包，可标记为未验证 |
| 电脑端 | 2 台电脑或 1 台电脑 + 1 个重置 identity 的临时实例 |

## 1. 扫码绑定

步骤：

1. 电脑端打开设置 -> 手机访问 -> 开启手机访问。
2. 生成扫码绑定二维码。
3. 手机端进入绑定页面，扫码绑定。
4. 绑定成功后关闭手机 App，再重新打开。
5. 在电脑端移除该手机，再用手机刷新视频库。

通过标准：

- 手机无需手动输入地址和 token 即可完成绑定。
- 手机重启后仍能自动连接。
- 同一个二维码不能重复绑定第二次。
- 二维码过期后不能绑定。
- 电脑端移除设备后，手机显示授权失效并要求重新扫码。

## 2. 多电脑管理

步骤：

1. 手机绑定电脑 A。
2. 手机绑定电脑 B。
3. 在手机设备列表中分别进入 A/B 的视频库。
4. 删除电脑 A。
5. 确认电脑 B 仍可正常进入和播放。

通过标准：

- 手机设备列表可同时保存多台电脑。
- 删除其中一台不会影响另一台。
- 删除绑定设备时会尝试撤销电脑端授权。
- 已失效设备不会静默卡死，必须给出可理解的离线/授权提示。

## 3. 局域网视频观看

步骤：

1. 分别使用 1k 和 5k 视频库进入视频库，确认两列缩略图加载。
2. 用侧边栏按目录、系统标签、自定义标签、收藏筛选。
3. 搜索视频名、目录名、标签名。
4. 打开视频进入沉浸式竖向播放器。
5. 上下滑动切换前后视频。
6. 连续播放 15 分钟，期间切换至少 30 次视频。

通过标准：

- 缩略图可见，不出现大面积空白。
- 1k 库滚动、搜索、筛选没有持续卡顿；5k 库允许短暂加载，但不能卡死或白屏。
- 视频流可正常播放，进度条可拖动。
- 上下滑动每次最多切换一个视频。
- 返回上一个视频能恢复播放进度。
- App 后台后暂停，回到前台按当前设置恢复或保持暂停。

## 4. 视频格式兼容

步骤：

1. 播放 MP4/H.264/AAC，确认直接播放。
2. 播放不兼容格式。
3. 点击“尝试转码播放”。
4. 等待转码进度完成后播放兼容 MP4。
5. 再次打开同一视频，确认复用转码缓存。

通过标准：

- 原生支持格式不触发转码。
- 不支持格式显示“当前格式无法直接播放”，不暴露底层堆栈。
- 转码中有进度和取消入口。
- 转码完成后能播放，并支持拖动进度。
- 再次播放同一源文件不重复等待完整转码。

## 5. 横屏与手势

步骤：

1. 打开横屏视频。
2. 点击横屏按钮进入系统横屏全屏。
3. 点击缩小按钮退出。
4. 重复 10 次。
5. 在竖屏播放器测试：
   - 单击暂停/继续。
   - 双击收藏。
   - 长按右半屏快进。
   - 长按左半屏快退。
   - 边缘右滑返回。

通过标准：

- 横屏时隐藏右侧竖向操作栏和左下信息区。
- 点击缩小按钮后真正退出系统横屏，并回到竖屏 feed，不只是把视频比例改回竖屏。
- 退出横屏后保持原视频和播放进度。
- 手势之间不互相误触。
- 刘海、状态栏、底部手势条不遮挡核心按钮和进度条。

## 6. 长时间与低内存压力

步骤：

1. 从冷启动进入视频库。
2. 连续播放 60 分钟。
3. 每 2 分钟上下滑动切换一次视频。
4. 每 10 分钟切换一次横屏再退出。
5. 第 30 分钟锁屏 1 分钟后解锁。
6. 第 45 分钟切到其他 App 2 分钟后返回。
7. Android 上使用系统开发者选项或后台应用切换制造一次内存压力。
8. Android 采集时使用 `qa-mobile-real-device.ps1 -Scenario playback-60m`；低内存专项使用 `-Scenario low-memory-restore -SendTrimMemory`。
9. 弱网专项中，先限速到 1 Mbps 以下播放 5 分钟，再断网 30 秒，恢复网络后继续播放，重复 2 轮。

通过标准：

- App 不崩溃、不白屏。
- 只有当前视频播放，离开页面的视频停止。
- 播放器返回前后台后不出现多个声音叠加。
- 缩略图和视频切换不持续变慢。
- 电脑端服务仍能响应 `/v1/info` 和视频库刷新。
- `performance-budget.json` 中 `automaticPass=true`；如果失败，必须把失败项写入记录模板。
- 手机端内存没有持续无界增长；Android 优先用脚本 PSS，iOS 如无法读数，用系统设置/开发者工具截图记录。

## 7. 记录模板

```text
日期：
电脑端版本：
手机端版本：
电脑系统：
手机型号：
系统版本：
网络环境：
视频库规模：
QA 场景：library-1k / library-5k / playback-60m / low-memory-restore / background-lock / weak-network
performance-budget.json 路径：
自动预算：通过 / 失败，备注：

扫码绑定：通过 / 失败，备注：
多电脑管理：通过 / 失败，备注：
局域网观看：通过 / 失败，备注：
格式兼容/转码：通过 / 失败，备注：
横屏与手势：通过 / 失败，备注：
60 分钟压力：通过 / 失败，备注：
低内存恢复：通过 / 失败，备注：
切后台/锁屏：通过 / 失败，备注：
弱网重连：通过 / 失败，备注：

失败截图/录屏路径：
电脑端日志路径：
手机端日志或崩溃记录：
```

## 8. 验收结论

只有当自动化验证和本文档真机矩阵都通过时，才能把“扫码绑定、多电脑管理、视频兼容、横屏打磨、性能验证”标记为完整完成。
