# Wallpaper Player 手机客户端与电脑服务端方案

## 目标

把当前的 Wallpaper Player 从“本地视频画廊播放器”扩展为：

```text
Windows 电脑端 = 本地视频管理器 + 私人媒体服务端 + 手机绑定中心
手机端 = 远程视频库浏览器 + 原生视频播放器
```

产品 v1 只解决核心体验：

```text
电脑开启手机访问
手机扫码或输入地址绑定
同一局域网内连接电脑
手机浏览、搜索、查看缩略图、播放电脑里的 MP4
关闭电脑主窗口后，手机访问服务仍可在托盘中运行
```

产品 v1 不做账号系统、云中继、P2P 打洞、HLS 实时转码、字幕同步。多电脑先支持本地设备列表、扫码绑定、失效提示和解绑；复杂的自动发现/漫游同步留到后续。

## 当前项目事实

当前项目已经具备服务端化的基础，不需要重写媒体库。

| 能力 | 当前位置 | 可复用方式 |
| --- | --- | --- |
| Electron 主进程入口 | `main.js` -> `main/index.js` | 在主进程生命周期中启动/停止 remote 服务 |
| 视频扫描与缓存 | `main/scanner.js` 的 `scanWithCache()` | 作为手机端视频库数据来源 |
| 路径白名单校验 | `main/scanner.js` 的 `assertAllowedVideoPath()` | 所有 remote 文件访问都必须复用 |
| 缩略图 | `main/thumbnail.js` 的 `resolveThumbnail()` | 作为手机端缩略图接口来源 |
| 播放进度 | `main/settings.js` 的 `playbackStates` | 可复用为手机端播放进度存储 |
| FFmpeg/mpv 运行时 | `vendor/` + `package.json` `extraResources` | 后续 HLS 转码可复用 FFmpeg |
| 桌面设置 UI | `src/components/Settings.jsx` | 增加“手机访问”设置区 |

需要特别注意：当前扫描结果会给桌面前端返回 `fullPath`。桌面端内部可以继续这样工作，但手机端 API 不能暴露 Windows 本机路径。

## 架构

```text
wallpaper-player/
├─ main/
│  ├─ index.js
│  ├─ scanner.js
│  ├─ thumbnail.js
│  ├─ settings.js
│  └─ remote/
│     ├─ index.js
│     ├─ server.js
│     ├─ identity.js
│     ├─ pairing.js
│     ├─ auth.js
│     ├─ device-store.js
│     ├─ video-index.js
│     ├─ library-api.js
│     ├─ thumbnail-api.js
│     ├─ stream-api.js
│     └─ discovery.js
│
├─ src/
│  └─ components/
│     └─ RemoteAccessSettings.jsx
│
└─ mobile/
   ├─ android/
   ├─ ios/
   └─ src/
```

`main/remote/` 是新增边界。它只调用现有主进程模块，不反向污染桌面 React 数据流。

## 分阶段计划

### 阶段 1：电脑端 remote API 验证

成功标准：

```text
电脑端可以开启一个本机 HTTP 服务
手机或浏览器使用临时开发 token 拉取视频列表、缩略图、Range 视频流
手机端响应中不出现 fullPath
窗口关闭后，在启用手机访问时服务仍继续运行
```

工作项：

1. 新增 `main/remote/` 模块。
2. 新增 remote 设置字段。
3. 新增托盘后台运行。
4. 新增 `videoId -> fullPath` 映射。
5. 新增视频列表、缩略图、Range 视频流接口。
6. 所有文件访问继续调用 `assertAllowedVideoPath()`。
7. 提供设置页可复制的临时访问 token，便于先验证播放链路。

这个阶段是工程验证阶段，不是完整用户体验。暂时可以用 Node 内置 `http`、`crypto`、`fs`、`stream` 实现，避免一开始引入过多依赖。

### 阶段 2：绑定与设备管理

成功标准：

```text
电脑显示绑定二维码
手机提交一次性绑定请求
电脑弹窗确认
绑定成功后手机持久保存 token
电脑可以移除已绑定设备
移除后手机立即失效
```

工作项：

1. 电脑生成一次性 pairing session。
2. 二维码包含 endpoint、pairingId、oneTimeSecret、expiresAt。
3. 手机调用绑定接口后进入 pending。
4. 电脑端确认设备，允许或拒绝本次绑定。
5. 电脑允许后，手机再次 claim 才换取独立设备 token。
6. 保存已绑定设备。
7. 所有 remote API 增加 token 鉴权。

产品 v1 的设备凭据可以使用随机 token。电脑只保存 token hash，不保存明文 token。后续安全增强再升级为设备密钥对和证书指纹固定。

### 阶段 3：手机 App

成功标准：

```text
手机可以绑定电脑
手机可以浏览视频列表
手机可以搜索
手机可以显示缩略图
手机可以播放 MP4
手机可以保存和恢复播放进度
```

技术建议：

```text
React Native + TypeScript
Android 优先
播放器使用 ExoPlayer 能力，例如 react-native-video
```

手机端结构：

```text
mobile/src/
├─ screens/
│  ├─ PairDeviceScreen.tsx
│  ├─ DeviceListScreen.tsx
│  ├─ LibraryScreen.tsx
│  ├─ SearchScreen.tsx
│  └─ PlayerScreen.tsx
├─ services/
│  ├─ api.ts
│  ├─ pairing.ts
│  ├─ secure-storage.ts
│  └─ connection-manager.ts
├─ stores/
│  ├─ devices.ts
│  ├─ library.ts
│  └─ playback.ts
└─ components/
   ├─ VideoCard.tsx
   ├─ DeviceCard.tsx
   └─ ConnectionStatus.tsx
```

产品 v1 连接策略：

```text
1. 尝试上次成功 endpoint
2. 失败时允许手动输入电脑地址
3. 后续再加入 mDNS 自动发现
```

### 阶段 4：增强能力

后续再做：

```text
mDNS 自动发现
HTTPS 与证书指纹固定
WebSocket/SSE 事件
HLS 实时转码
Tailscale 地址支持
字幕
收藏/标签同步
多电脑切换
下载到手机
```

## 电脑端 remote 模块设计

### `index.js`

职责：

```text
读取 remote 设置
启动/停止 server
管理托盘状态
向桌面 UI 暴露 IPC
```

建议接口：

```js
async function startRemoteAccess()
async function stopRemoteAccess()
function getRemoteAccessState()
```

### `server.js`

职责：

```text
创建 HTTP server
解析请求
路由到 library/thumbnail/stream/playback/pairing/auth
统一返回 JSON 错误
```

阶段 1 监听：

```text
0.0.0.0:38127
```

端口被占用时应返回明确错误，并允许用户在设置中修改端口。

### `identity.js`

职责：

```text
生成并保存电脑 deviceId
生成并保存 machineSecret
提供稳定 videoId 计算能力
```

保存位置：

```text
app.getPath('userData')/remote-identity.json
```

示例：

```json
{
  "deviceId": "pc_f98bd812",
  "machineSecret": "base64url-random-secret",
  "createdAt": 1781954800000
}
```

### `video-index.js`

职责：

```text
把扫描结果转换为手机端 DTO
维护 videoId -> fullPath 映射
根据 videoId 取回安全路径
```

规则：

```text
videoId = "video_" + HMAC-SHA256(machineSecret, pathKey(fullPath))
```

手机端 DTO：

```json
{
  "id": "video_xxx",
  "name": "城市夜景",
  "fileName": "city-night",
  "extension": ".mp4",
  "size": 83818374,
  "modified": 1781954800000,
  "group": "风景",
  "tags": ["夜景", "城市"],
  "thumbnailUrl": "/v1/videos/video_xxx/thumbnail",
  "streamUrl": "/v1/videos/video_xxx/stream"
}
```

禁止返回：

```text
fullPath
playbackKey
previewPath
```

### `library-api.js`

职责：

```text
读取已添加视频目录
调用 scanWithCache()
合并扫描结果
返回手机端 DTO
```

阶段 1 接口：

```http
GET /v1/library
```

响应：

```json
{
  "items": [],
  "count": 0,
  "scannedAt": 1781954800000
}
```

产品 v1 可以先返回全量列表。后续再支持分页、增量变化、按目录过滤。

### `thumbnail-api.js`

职责：

```text
根据 videoId 找到 fullPath
调用 assertAllowedVideoPath()
调用 resolveThumbnail()
返回 image/jpeg 或实际图片类型
```

接口：

```http
GET /v1/videos/:videoId/thumbnail
```

注意：

```text
如果缩略图不存在，返回 404 或占位图
不要返回本机 file:// URL
不要暴露缩略图磁盘路径
```

### `stream-api.js`

职责：

```text
根据 videoId 找到 fullPath
调用 assertAllowedVideoPath()
支持 HTTP Range
返回原文件视频流
```

接口：

```http
GET /v1/videos/:videoId/stream
```

必须支持：

```http
Range: bytes=1048576-
```

响应：

```http
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 1048576-2097151/83818374
Content-Length: 1048576
Content-Type: video/mp4
```

没有 Range 时可以返回完整文件，但需要限制大文件并发，避免手机误触导致电脑磁盘和网络被打满。

### `pairing.js`

职责：

```text
创建一次性绑定会话
校验 oneTimeSecret
过期清理
```

二维码内容：

```json
{
  "version": 1,
  "deviceId": "pc_f98bd812",
  "deviceName": "Wallpaper Player",
  "endpoint": "http://192.168.1.105:38127",
  "pairingId": "pair_Y4s81",
  "oneTimeSecret": "base64url-secret",
  "expiresAt": 1781955000000
}
```

二维码 URI：

```text
wallpaper-player://pair?data=BASE64URL_JSON
```

### `auth.js`

职责：

```text
验证绑定设备 token
为请求提取 deviceId
提供限流和失败计数
```

产品 v1 请求头：

```http
Authorization: Bearer <token>
```

电脑只保存：

```text
sha256(token)
```

不保存明文 token，不在日志中打印 token。

### `device-store.js`

职责：

```text
保存已绑定手机
移除设备
更新 lastSeenAt
```

保存位置：

```text
app.getPath('userData')/remote-devices.json
```

示例：

```json
{
  "devices": [
    {
      "deviceId": "phone_8821",
      "name": "旭东的 iPhone",
      "tokenHash": "sha256...",
      "permissions": ["library.read", "video.stream", "playback.write"],
      "createdAt": 1781954800000,
      "lastSeenAt": 1781954800000
    }
  ]
}
```

## HTTP API

阶段 1 接口：

```http
GET  /v1/info

GET  /v1/library
GET  /v1/videos/:videoId/thumbnail
GET  /v1/videos/:videoId/stream

GET  /v1/playback/:videoId
PUT  /v1/playback/:videoId
```

阶段 2 新增接口：

```http
POST   /v1/pairing/claim
DELETE /v1/devices/current
PUT    /v1/videos/:videoId/favorite
PUT    /v1/videos/:videoId/tags
POST   /v1/videos/:videoId/play-on-desktop
POST   /v1/videos/:videoId/reveal-on-desktop
POST   /v1/videos/:videoId/transcode
GET    /v1/videos/:videoId/transcode
DELETE /v1/videos/:videoId/transcode
GET    /v1/videos/:videoId/transcoded-stream
```

鉴权规则：

```text
/v1/info 可以匿名访问
/v1/pairing/claim 只能使用有效一次性 pairing session
阶段 1 的媒体接口必须携带临时开发 token
阶段 2 起媒体接口必须携带绑定设备 token；旧临时 token 保留为兼容入口
```

错误响应：

```json
{
  "error": {
    "code": "unauthorized",
    "message": "设备未授权"
  }
}
```

## 桌面 UI

在设置中新增“手机访问”区。

阶段 1 字段：

```text
手机访问：开启/关闭
访问地址：http://192.168.x.x:38127
端口：38127
关闭窗口后保持手机访问：开启/关闭
复制临时访问 token
```

阶段 2 增加：

```text
绑定新手机
已绑定设备列表
移除设备
```

绑定弹窗：

```text
新的设备请求绑定

设备：旭东的 iPhone
地址：192.168.1.116
验证码：618 427

[拒绝] [允许]
```

阶段 1 只显示访问地址和临时 token；当前实现已补齐二维码绑定，mDNS 自动发现留到后续。

## 托盘行为

当前 `window-all-closed` 会退出应用。启用手机访问后需要改为：

```text
点击关闭窗口
  -> 隐藏窗口
  -> remote 服务继续运行
  -> 托盘菜单可重新打开主界面
```

只有点击托盘菜单的“退出”，或手机访问未启用时关闭所有窗口，才真正退出。

退出前必须：

```text
停止 remote server
关闭目录 watcher
销毁 mpv
注销快捷键
保存必要状态
```

## 安全要求

必须做到：

```text
手机访问默认关闭
remote API 不接收任意 file path
remote API 只接收 videoId
videoId 解析后仍调用 assertAllowedVideoPath()
不向手机返回 fullPath
不向手机返回 file:// URL
token 只保存 hash
日志不打印 token、oneTimeSecret
绑定二维码短期有效且只能使用一次
移除设备后 token 立即失效
限制认证失败频率
限制视频流并发
```

产品 v1 可以暂用局域网 HTTP + token。HTTPS、证书指纹固定、设备密钥对是后续安全增强，不应阻塞产品 v1 的播放链路验证。

## 手机端体验

阶段 1 工程验证：

```text
电脑开启手机访问
电脑显示访问地址和临时 token
手机输入地址和 token
进入视频库
```

产品 v1 第一次使用：

```text
电脑开启手机访问
电脑显示二维码和访问地址
手机扫码
电脑确认
手机保存电脑凭据
进入视频库
```

后续使用：

```text
打开手机 App
尝试上次 endpoint
成功则进入视频库
失败则显示离线状态并允许修改地址
```

播放体验：

```text
优先播放 MP4/H.264/AAC
支持拖动进度条
支持横屏
支持断线重试
定期保存播放进度
```

不支持格式在产品 v1 中提示，并可请求电脑端准备兼容 MP4：

```text
当前格式无法直接播放
尝试转码播放 / 重试 / 查看详情
```

## 后续增强

### mDNS

服务名：

```text
_wallpaper-player._tcp.local
```

TXT 信息：

```text
deviceId=pc_f98bd812
name=Wallpaper Player
port=38127
version=1
```

手机发现后仍必须验证 deviceId 和 token，不能因为发现到了服务就信任它。

### HTTPS 与证书指纹固定

后续增加：

```text
电脑生成本地自签证书
二维码包含 certificateFingerprint
手机固定该指纹
API 和视频流走 HTTPS
```

需要先验证原生播放器对自签 HTTPS 视频流的处理方式。这个风险不应压到产品 v1 上。

### HLS 转码

后续增加：

```text
MKV/AVI/WMV/RMVB 等格式转 HLS
支持 1080p/720p/480p 档位
优先 h264_nvenc
回退 libx264
限制并发转码任务
```

FFmpeg 查找逻辑可以复用 `main/thumbnail.js` 的 `findFfmpeg()`。

### Tailscale

第二或第三版支持显示 Tailscale 地址。项目本身不负责安装或管理 Tailscale，只把它当成可用 endpoint。

## 验收清单

阶段 1 完成标准：

```text
开启手机访问后，电脑监听指定端口
GET /v1/info 返回电脑信息
携带临时 token 或绑定设备 token 时，GET /v1/library 返回视频列表且不包含 fullPath
携带临时 token 或绑定设备 token 时，GET /v1/videos/:id/thumbnail 返回图片
携带临时 token 或绑定设备 token 时，GET /v1/videos/:id/stream 支持 206 Range
关闭主窗口后，服务仍在托盘中运行
关闭手机访问后，端口停止监听
```

阶段 2 完成标准：

```text
二维码过期后不能绑定
同一个 pairing session 只能成功一次
未绑定设备不能访问 library/thumbnail/stream
移除设备后旧 token 不能继续访问
日志中没有 token 和 oneTimeSecret
```

阶段 3 完成标准：

```text
手机绑定一次后可再次自动连接
手机能浏览视频和缩略图
手机能播放 MP4
手机能拖动进度条
手机能保存和恢复播放进度
电脑 API 响应中不出现 Windows 路径
```

当前实现验证命令：

```bash
npm run verify:mobile-lan
npm run verify:remote-pressure
npm run build
cd mobile && npm run typecheck
```

`verify:mobile-lan` 已包含 `verify:remote-library` 和 `verify:mobile-multi-device`，会临时生成视频库并自动验证：扫码绑定 pending -> 电脑端允许 -> 手机换取独立 token、扫码请求主动刷新电脑端待确认状态、默认临时 Token 不能访问正式媒体 API、拉取库列表、确认不泄露本机路径、获取绑定缩略图、HTTP Range 视频流、大视频无 Range 请求被拒绝、多次并发小 Range/缩略图/库读取、播放进度保存、收藏与自定义标签同步、720p 转码 API 生成兼容 MP4 并支持 Range 播放、VP9/Opus MKV 等不兼容源可经 API 转为 H.264/AAC MP4、撤销单台手机后旧 token/旧缩略图 token/旧视频流全部失效，且另一台已绑定手机仍可继续访问。`verify:mobile-multi-device` 会启动两个独立临时电脑身份，验证 A/B 设备切换、跨电脑 token 不互通、删除 A 不影响 B。
`verify:mobile-transcode-concurrency` 使用临时 FFmpeg stub 验证同一时刻只允许一个电脑端转码任务运行，避免多设备同时转码打满 CPU/磁盘。
`verify:remote-pressure` 会临时生成 3 个视频条目，循环执行库读取、并发缩略图请求和并发 Range 视频流请求，同时检查响应体、状态码、路径隐私和 Node heap 增长边界，用作无头环境下的长期/资源压力替代验证。
真机低内存、系统横屏、刘海/手势区和 60 分钟播放压力按 `docs/mobile-real-device-qa.md` 执行；未完成该清单前，性能验证只能算自动化层面通过。

当前已落地：

```text
一次性二维码绑定：电脑端生成 pairingCode，手机端 claim 后等待电脑端确认，允许后再换取独立设备 token
设备管理：电脑端列出/允许/拒绝待绑定设备，列出/移除已绑定设备；手机端删除设备时尝试撤销电脑端授权；手机设备列表显示在线、离线、授权失效和地址错配状态
多电脑连接：手机端保存设备列表，连接时比较 endpoints、吞吐和 deviceId，fallback 也验证 token，防止 IP 复用误连；网络临时失败时使用指数退避重连，授权撤销和设备错配不无限重试
移动端播放：原始 Range 流优先，失败后可请求电脑端生成 H.264/AAC MP4 兼容缓存；更多菜单支持 1080p/720p/480p 兼容转码流；不兼容源文件已通过 API 级转码验证
播放器体验：竖向分页、单播放器、前后轻量预览、进度节流、横屏退出回竖屏，横屏控制浮层保留收藏/标签/缓存/电脑端播放/更多
性能保护：单播放器、前后轻量预览、播放进度 5 秒节流、电脑端转码并发限制、大视频无 Range 请求限制、认证失败频率限制、无头压力脚本
验证覆盖：电脑端确认式扫码绑定、设备撤销、默认临时 Token 降级、撤销后绑定缩略图 token 失效、远程 API 冒烟、LAN 视频库/缩略图/Range 流/大视频无 Range 限制/多设备撤销/双电脑身份隔离/轻压力回归、无头远程长期/资源压力回归、运行中端口变更重启约束、移动端多设备存储和授权失效结构约束、播放器单实例/竖向分页/长按左快退右快进/横屏退出回竖屏结构约束、FFmpeg 命令与不兼容格式 API 转码路径、转码并发限制
```

仍属于后续增强：

```text
mDNS/Bonjour 自动发现
HTTPS/证书指纹固定
HLS 自适应码率与长期转码队列
真实多机低内存和长时间压力测试
```

## 推荐实施顺序

```text
1. 新建 main/remote/，实现 /v1/info
2. 实现 video-index，确保 DTO 不暴露 fullPath
3. 实现 /v1/library
4. 实现 /v1/videos/:id/thumbnail
5. 实现 /v1/videos/:id/stream Range
6. 增加设置 UI 和开启/关闭 remote 服务
7. 增加托盘后台运行
8. 增加 pairing/正式 token/设备管理
9. 开始手机 App MVP
10. 再做 mDNS、HTTPS、HLS
```

这条顺序能最早验证真正的高风险点：手机是否能稳定播放电脑上的视频流。
