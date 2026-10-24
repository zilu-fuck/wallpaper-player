# 共享协议与接口边界

`packages/contracts/src/index.ts` 定义媒体 DTO、请求/响应 schema、能力和错误规则；`schema.ts` 提供无框架依赖的校验器。TypeScript 构建生成 `dist/*.js` 与声明文件，Electron、Vite 和 Metro 消费同一份运行时代码。手机的 `src/types.ts` 转导出这些类型，桌面的 `src/api/media.ts` 是实际调用入口。

执行 `npm run build:contracts` 更新生成文件；`npm run verify:contracts` 检查生成结果与源码一致，并运行行为兼容测试。普通桌面构建会先生成契约。CI 在重建之前验证生成文件，防止源码和已提交声明/运行时发生漂移。

## 能力与兼容

HTTP 路径仍使用 `/v1`。`/v1/info` 返回 `protocolVersion: 2`、`minClientProtocol: 1` 以及 capabilities。省略新字段的旧桌面按协议 1 处理，未声明能力一律按 false；不从桌面版本号推测能力。高于当前手机支持的最低协议返回 `unsupported_protocol`，提示更新。

| 能力 | 新请求/响应 | 旧桌面兼容 |
| --- | --- | --- |
| favoriteState | PUT 的 favorite 为明确布尔状态 | 空请求体保留 toggle |
| mediaMutationResults | 批量标签必须有 updated 和 failed，数量与结果一致 | 接受仅有 updatedCount/tags 的旧结果 |
| tagRevisions | GET 标签快照；替换携带 expectedRevision/operationId，返回 customTagsRevision | 省略条件保持旧替换语义，旧桌面从缓存初始化编辑 |
| playbackRevision | 进度使用 baseRevision/session/sequence，响应必须有已提交进度与 revision | 仅发送 position，接受旧 success 结果 |
| authProbe | GET /v1/auth 检查当前授权和电脑 ID | 保留 64 KiB 授权探测 |
| taskInterests | 转码请求携带每次操作的 interestId，取消仅释放本订阅 | 新手机不向旧桌面发送订阅字段；旧手机在新桌面按认证调用方隔离 |
| analysisInterests | 分析 GET/POST/DELETE 携带 interestId，响应含 canCancel、interestedClients、interestCancelled | 缺省 false；旧分析观察/启动继续可用，手机独立取消要求此能力 |
| libraryQuery / libraryRevision / cursorPagination | POST 组合查询、库 revision 和签名游标；R5 已声明 | 读取完整旧快照并在本地查询 |

新桌面接受有效旧请求，附加字段不影响旧手机。新版手机不能因解析失败自动退回旧修改协议；只有能力协商结果允许选择旧路径。已验证新手机/新桌面、旧手机请求/新桌面、新手机/旧桌面 HTTP 矩阵。

## 校验范围

HTTP 的 `readBody` 和 `sendJson` 对已定义核心接口使用共享请求和响应 schema。覆盖 info、配对、库、进度、收藏、标签与批量标签、隐藏标签恢复、转码状态/列表/缓存、桌面播放/定位、视频元数据和官方分析响应。库的 offset/limit、转码 quality 也校验。视频流、图片和测速字节使用独立流式协议，错误仍使用统一 JSON 格式。第三方插件的自定义路由继续由其能力和生命周期管理，不能冒充这些核心 DTO。

桌面已迁移收藏、标签、批量标签、扫描和 HTML5 进度的真实消费者。对应 IPC 在业务调用之前检查参数，在返回前检查结果；adapter 对实际桥响应再次校验，失败转为可展示的异常。其余既有桥方法保留兼容接口，随 R6 的播放器/任务和 R7 的功能边界继续迁移，统一 sender/frame 来源约束由后续安全验收覆盖。

手机 JSON 请求必须携带具体响应 schema，移除了 `as T` 的响应信任。配对码也校验结构。声明新能力却缺少对应返回值视为 `invalid_response`，不能按旧协议猜测成功。原有第三方插件字段通过明确的扩展边界保留。

## 错误与同步

标签替换在同一提交队列检查每个目标的版本；文件别名共享版本，Workshop 按既有分组共享，网络 URL 保留路径及查询的大小写。批量追加推进目标版本。编辑器先读取快照并固定版本，外部元数据变化不更新编辑基准；冲突保留草稿，明确重新载入才采用新版本。分析标签使用追加接口。

operationId 按认证设备和目标/请求内容确认，最近 1024 条回执与标签和版本原子落盘。相同操作的重复确认不写盘；编号复用到不同目标或内容会拒绝。回执已淘汰的重试仍受旧 expectedRevision 约束；相同内容的无变化操作不推进版本。服务重启保留确认，手机响应只返回当前标签及操作版本，不返回回执或路径身份。

HTTP 错误格式为 `{ error: { code, message, retryable, currentRevision?, currentLibraryRevision? } }`；IPC 保留旧 success/error 字段，并附带 code/retryable。`playback_conflict` 携带当前 revision；客户端读取当前位置后处理冲突。服务端不向手机返回堆栈或媒体绝对路径。

| code 或情形 | 处理 |
| --- | --- |
| network_error、timeout、429、普通服务故障 | 允许退避重试，保留待同步意图 |
| unauthorized、legacy_token_disabled | 停止自动操作，要求恢复授权或重新绑定 |
| invalid_request | 修正输入 |
| invalid_response、unsupported_protocol | 停止自动重试，提示更新/重新连接 |
| tags_conflict、operation_id_reused | 保留草稿并停止自动重试；重新载入或重新打开编辑 |
| playback_conflict | 保留本地意图，读取远端，显式操作可基于新版本提交 |
| device_mismatch、device_binding_changed | 返回设备列表选择当前绑定 |

库重连消费 retryable，进度仓库将不可重试错误持久化，避免后台循环重复提交；显式操作或新会话可再次尝试。旧服务未提供 retryable 时按状态与错误码分类。

## 构建边界与证据

两个 npm 依赖树仍独立，共享包无新增运行时依赖。Windows 打包暂存复制 packages，electron-builder 明确包含 contracts 和 domain 的 package.json 与 dist。`verify:packaged-contracts` 根据实际打包规则创建 ASAR，并在真实 Electron 中加载打包后的共享契约与 HTTP 序列化器。

Expo 56 当前的导出实现会在启用 on-demand filesystem 时裁剪额外 watchFolders；实际导出曾无法读取 sibling 包。保留 mobile 为项目根，在 app.json 关闭该模式，并为 contracts 添加监听目录与手机依赖搜索路径，避免 Hermes 查找落到桌面项目。R8 升级 Expo 时重新验证此配置。[Expo 共享工程说明](https://docs.expo.dev/guides/monorepos/)

`verify:mobile-bundles` 导出 Android 和 iOS 的 Hermes 字节码，核对 source map 包含当前 contracts 的 index/schema/settings-feed 运行时文件与 domain 查询模块，并确认只有手机锁定版本的 React。证据写入 `.tmp/refactor-tests/contracts-bundles-evidence.json`。这是 bundler 与运行时代码分发证据；APK/IPA、安装覆盖、原生网络/解码及真机内存验收仍属于 R6–R8。

## R5 查询契约

libraryQuery、libraryRevision、cursorPagination 三项能力一起用于手机分页；缺省为 false，旧服务仍由客户端本地查询完整快照。新服务保持旧 GET /v1/library 语义，同时提供 POST /v1/library/query（默认 200、上限 500）、GET /v1/library/revision，以及每页 100 项的 GET /v1/library/categories。

查询支持目录、明确的收藏状态、类型化标签包含交集/排除并集、文本搜索和 name/date/size/type 排序。全库计数与筛选匹配数分开，aggregationScope 明确为 visible-library，分类通过 categoryPagination 继续读取。目录重叠按资源去重，但每个目录的成员关系保留。

nextCursor 绑定认证令牌、完整归一化查询、用途和 revision。无变化进度不推进库 revision；配置和用户媒体修改触发必要失效。过期游标返回 409 cursor_stale 和 currentLibraryRevision，客户端重读新版本；签名、查询或设备不符返回 400 invalid_cursor，不使用 offset 猜测续页。扫描中的结果通过 scanState 告知仍在更新。

手机缓存只复用同绑定、同查询的完整前缀；断网时不把部分库当成全量搜索。响应缺少承诺的分页字段仍为 invalid_response，不能自动降级全量协议。两端查询谓词和归一化聚合来自 packages/domain；桌面已有的类型分组排序继续由桌面提供。

R6 的 authProbe 验证每次连接的当前授权，不缓存授权成功；能力缺省为 false，声明能力却返回无效响应不会降级旧探测。连接请求共享取消只在最后消费者离开时中止。

## R6 分析任务订阅

analysisInterests 与转码 taskInterests 独立协商。相同视频的明确启动操作共用现有分析工作；其他视频仍返回忙碌状态。每次操作用独立 interestId，认证设备/凭证摘要与桌面窗口世代分别识别调用方。取消只释放对应调用方的这次订阅，最后一个有效订阅释放后才结束工作；离开手机页面只停止观察。不同视频的观察响应不包含当前视频的路径、ID 或进度。

手机通过 GET /v1/videos/:id/analysis?interestId=... 恢复观察，通过 POST 加入或启动，通过 DELETE 释放。DELETE 可带 jobId 拒绝旧任务取消；订阅本身已经隔离每次操作。取消回执按调用方和 interestId 最多保留 2048 条、10 分钟，阻止期间迟到的 POST 重新加入，不承诺跨服务重启保存。分析最多一个底层工作和 128 个订阅。

声明 analysisInterests 的服务必须在非空 job 中提供 interestId、canCancel、interestedClients 和 interestCancelled；字段缺失或可取消状态与当前视频/订阅矛盾视为 invalid_response。取消返回明确的 released、taskCancelled、shared，手机在共享取消时说明其他调用方仍在工作。取消确认丢失保留同一订阅重试；新的明确启动生成新订阅，旧回复不能清除新操作。

桌面 startVideoAnalysis/cancelVideoAnalysis 保留旧调用并增加可选 interestId；旧调用仅拥有本窗口的 legacy 订阅。窗口主页面导航或销毁释放所属订阅；配对撤销、媒体权限或隐私锁定使对应订阅失效，其他有效调用方继续持有工作。桌面任务按 job ID 处理事件，短暂保存最多 128 个任务的最新事件以接住早于 IPC 回复的完成；旧任务事件不能关联到同路径重试任务。

## R7 JSON 响应传输

业务 JSON 结构和协议版本保持现有约定，旧 GET /v1/library 无分页参数时仍返回完整结果，不静默截断。JSON 压缩进入进程内 JsonResponseService，使用异步 gzip；正常响应仍提供准确的 Content-Length、Content-Type、Cache-Control: no-store 和 Vary: Accept-Encoding，HEAD 不发送正文。大正文按最多 64 KiB 写入，等待 drain，每轮最多写四块后让出执行，不使用额外的 HTTP chunked 编码替代 Content-Length。

编码协商处理显式 q=0、通配项和 identity：默认只对至少 1 KiB 的可压缩响应使用 gzip；若客户端拒绝 identity 而接受 gzip，小响应也压缩。两种可提供表示均被拒绝时返回无正文的 406。规则依据 [RFC 9110 §12.5.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)。

| 资源 | 当前上限 |
| --- | --- |
| 全进程未结束 JSON 响应 | 32 项 |
| 同一 HTTP 服务未结束响应 | 16 项 |
| 同时进入原生 gzip 的任务 | 2 项 |
| 单响应 UTF-8 JSON | 32 MiB |
| 输入/输出缓冲保留预算 | 全进程 128 MiB，压缩按输入两倍加 64 KiB 计入 |
| 排队及发送期限 | 入场起 15 秒，使用单调时钟，准备完成和继续发送前再次检查 |

配额超限返回 503 response_busy；正文超过上限返回 503 response_too_large，提示使用分页。已接收的缓冲保留到写入结束或连接关闭；已进入原生 gzip 的取消任务还须等待回调，不提前归还压缩名额或预算。队列中的取消/关闭任务不再发出原生工作。主服务停止或重启同时关闭本服务的 JSON 响应并等待其实际收尾。

超时、压缩失败或替换错误响应时只写一次有限的错误帧；头部已发送则关闭连接，不把第二份 JSON 拼在正文后。紧急错误帧不再次排队压缩；客户端若禁止 identity，保留 HTTP 错误状态并不附正文。手机 API 对无法解析的 HTTP 错误正文已有按状态生成 ApiError 的处理。该应急路径与资源预算不承诺控制整个 JS 堆、已构建业务对象、同步契约校验/JSON 序列化的临时空间或操作系统 socket 内存。

受保护 JSON 在准备时建立目录配置签名；排队入场、发送头部和继续写块时检查当前授权与目录配置。头部发送前重新读取凭证；块间使用同步授权世代识别应用内撤销、令牌轮换及同设备重绑，世代变化后再查凭证，稳定传输不逐块读身份文件。权限在库构建期间改变时，原库服务仍可重建新快照；准备之后改变则在头部前返回 401/409，或在部分发送后中止连接。已发出的字节无法撤回，不把此检查称为跨文件或网络原子事务。

身份读取在请求入场及发送前使用异步 `refreshIdentity`，包括未通知应用的文件修改；只有尚未开始的刷新可以合并。`loadIdentity` 返回独立快照，已准备时读取内存；需要观察外部凭证变化的调用方先等待刷新。配对领取、撤销和旧 Token 轮换返回 Promise，调用方必须等待原子文件替换后再确认成功。访问记录异步合并，写入前复核当前设备的令牌哈希；失败只记录并重试，不覆盖新绑定。JSON 授权刷新期间继续保留响应预算，关闭必须等待实际刷新完成。

插件路由保留同步 `authorizeMedia(req, res)`，并新增 `authorizeMediaAsync(req, res)`；当前分析插件优先等待异步入口，旧核心可回退到同步入口。旧同步桥与异步身份工作争用时返回可重试的 `503 identity_busy`，不交错写文件。核心 `remote/authorization` 增加可等待的 `refresh`，`isAuthorized` 继续同步读取当前缓存；分析任务在实际授权回调中先刷新。以上未改变手机 HTTP 请求或共享 schema。

设置持久化保留 JSON 文件和原事务队列。后台线程按缓存标识接收完整基线或修改字段，生成规范文本、规范字段和落盘字节；主线程负责原子替换，成功后才发布缓存及通知。基线不匹配、线程退出或空闲回收后重新传入当前私有基线；失败候选不能作为已提交基线。编码阶段单任务，默认 30 秒期限、空闲 60 秒回收；超时、强制关闭和异常响应等待实际线程退出。正常退出先 flush 再回收，紧急同步退出仍保留兼容路径。Node worker 的使用与数据传输规则参照 [Node.js 官方文档](https://nodejs.org/api/worker_threads.html)，ASAR 可用性另以实际 Electron 校验。

`updateSettingsAndFlush` 默认仍返回完整独立设置副本；仅明确指定 `returnSettings: false` 时省去该副本。手机媒体服务使用此选项，只返回原有业务结果，桌面 IPC 的设置快照与版本字段不变。自定义字段序列化保留属性名语义；目录重合并对照实际编码文本决定补写。读取、副本解析、自定义/同步入口和 renderer/IPC 工作仍可能在主线程执行，后台编码不能理解为零复制或跨文件崩溃事务。

主动解除自身绑定的成功回执允许确认已完成的撤销，仍受连接/服务生命周期约束；传输失败不会回滚已经提交的用户修改。verify:json-responses 覆盖资源、编码、真实 socket、生成的 10k 旧格式 HTTP 数据，以及生产服务的授权与权限变化；真实文件/索引和设备验收范围另见实施记录。

## R7 桌面设置增量 feed

preload 同时提供 `getSettingsFeed` 和 `onSettingsPatched` 时，当前 SettingsClient 使用增量订阅；任一缺失继续使用原有 `getSettings` / `onSettingsChanged`。共享 `settingsFeedSchema` 与 `settingsEventSchema` 约束消息，旧完整读取、保存回复及 HTTP 契约保持原样。

`settings-get-feed` 返回 `{kind: 'settings-feed-v1', feedId, snapshot}`；snapshot 包含 `_settingsVersion: {epoch, revision}`。feedId 绑定实际主窗口、主 frame、精确应用入口及导航世代；同一有效页面的重复完整读取保留 feedId 并重新设定发布游标，导航后的页面重新取得 feed。请求与主动广播都校验当前来源，未绑定页面、其他窗口、子 frame、导航等待和旧世代不能读或接收。

协商后通过 `settings-patched` 接收两种消息：

- `{kind: 'settings-patch-v1', feedId, baseVersion, version, set, removed, maps}`：仅当客户端当前版本严格等于 baseVersion 且 epoch 相同时应用；version 必须在同一 epoch 中递增。根字段 set/removed/maps 互不重叠，不能修改 `_settingsVersion` 或 `tagMutationReceipts`；版本由消息单独提供。
- `{kind: 'settings-snapshot-v1', feedId, snapshot}`：同步兼容提交、发布游标有缺口或无法安全复用编码候选时，提供完整恢复快照。旧版本不得覆盖更新的确认状态。

maps 仅允许 customTags、customTagRevisions、playbackStates，单项为 `{set, removed, order?}`。set 替换实体，removed 删除实体；order 只在自然键顺序与目标不同的时候发送，必须恰好覆盖结果键且不重复。应用时保留特殊属性名和未变实体引用，整条消息校验及构造完成后才发布。其他根字段仍按完整字段替换，数组没有隐含的逐元素合并协议。

privacy 仅允许 `{passwordSet: boolean}`，完整及增量消息均不得包含密码材料或 tagMutationReceipts。主进程的提交元数据与局部读取接口只在内部使用；按需副本不将私有缓存引用交给订阅方。线程实体增量是内部编码结果，文件仍按完整 JSON 写入，不更改落盘格式。

客户端对缺失/乱序的版本触发合并的完整恢复读取，同一所有者最多一个在途 feed 读取；回复前的新事件只记有界版本需求（最多八个 feed），读取完成后判断是否再恢复。有效完整基线消除请求前已有的无效时钟需求，避免永久未来时钟造成无限重读；等待期间的新需求保留。界面退役后不发布旧读取或恢复结果，当前失败保持可见。

未协商 feed 的客户端继续接收 `settings-changed` 完整快照。当前 preload 的旧监听器首次订阅/末次退订通过 `settings-legacy-listener` 发送 `{enabled, sequence}`；主进程仅接受更大顺序号。旧监听存在时与增量同时发送完整事件，保持独立消费者兼容。同一页面的其他 feed 读取不会轮换 token；若该读取推进了发布游标，落后的消费方在后续版本缺口时按上述规则恢复。

`verify:settings-feed` 包括受控客户端/实际仓库测试和生产 sandbox preload 的真实 Electron 检查，覆盖初始握手、增量、旧订阅、丢失事件、私密字段、导航拒绝及重载。初次读取、恢复、旧事件及桌面保存回复仍可能传输完整快照，不能把增量握手理解为全部设置操作零复制。

## R7 配置与媒体操作回执

`saveSettings(settings, options?)`、`setVideoFavorite(target, desired, options?)`、`getVideoCustomTags(target, options?)`、`appendVideoCustomTags(targets, tags, options?)` 和 `setVideoCustomTags(target, tags, condition?, options?)` 在原通道上接受可选 `{settingsReply: 'version-v1'}`。标签回执选项位于原 CAS 条件之后，不混用两种参数。无选项保留完整 settings 返回；未知选项在修改前拒绝。当前 renderer 具备两项 feed 能力时请求该模式；旧 preload/主进程忽略新参数而返回完整设置时，当前客户端仍接受原有结果。

该模式成功返回原业务字段及 `settingsVersion: {epoch, revision}`，不包含 settings。版本由本次事务提交或只读/无变化基线取得并复制；读操作和幂等重放也可能返回相同版本。内部 `returnSettings: false` 与 `returnVersion: true` 分别控制副本和版本，其他调用返回形状不变，手机 HTTP 响应没有新增字段或能力。失败不携带成功回执；已经提交的修改不会因返回或后续状态同步失败被撤销。同步兼容重合并及跨文件/崩溃边界沿用已有持久化语义，回执没有额外的崩溃事务保证。

SettingsClient 及收藏/标签消费点比较已确认状态与回执版本：同 epoch 且已达到对应 revision 时继续，落后时合并一次当前完整 feed 读取；读取失败或仍未达到则明确报告同步未完成，不永久等待广播，也不自动重发修改。标签重试继续使用既有 operationId/CAS；批量业务结果和失败项保持原样。旧回执不能覆盖更新状态，配置意图仍由原队列按提交顺序协调。

`verify:settings-replies` 覆盖受控回执/事务；扩充的实际 Electron feed 测试覆盖生产 adapter 的小回执、最后一条广播丢失及旧返回。完整 App 的设置快照 UI 还实际验证收藏和标签 hook 对回执的消费。完整初始/恢复、旧客户端及尚未迁移的网络资源/下载等返回仍可携带全量设置。

内部媒体仓库按 favorite/readTags/writeTags/appendTags/playback 操作限定读取与可提交字段，仍与配置共用原 JSON 写入队列。设置事务的可选 fields/prepareFields 在入队前捕获；异步准备后读取最新选定字段，默认调用和明确要求的旧完整结果保持完整快照。准备标签路径时只取得独立键名，业务标识不作为本地路径解析；原始路径与别名仍有界异步解析并复核当前权限。该领域边界不改变外部 schema、文件布局、CAS/幂等或持久化成功语义，也不承诺全部字段已独立落盘或逐实体更新。

## R8 设置文件格式与恢复

主设置保持平面 JSON，新写入带保留的 `schemaVersion: 1`；无版本文件视为旧格式 0。它是磁盘格式标记，不是 HTTP protocolVersion 或 IPC 的 `_settingsVersion` 时钟。普通保存忽略输入的 schemaVersion，扩展不能注册同名根字段。手机 HTTP 结构和能力协商不变。

`settings.v1.backup.json` 保存上一可读落盘版本，首次创建会在主写入后补备份；后续提交在替换主文件前更新备份。两份文件各自用同目录随机临时文件与 rename，不构成跨文件原子事务或断电保证。备份不经 renderer 广播，仍可能包含原设置的敏感配置；文件权限沿用数据目录/已有文件模式，新 POSIX 文件默认仅所有者读写。旧格式升级的辅助记录 `settings-migration.json` 保存当时来源/目标摘要，后续备份轮换不保证当前备份一直对应该历史摘要。

只有主文件与备份都缺失才使用默认设置。读取到损坏 JSON、非对象或不支持版本时，写入不会用默认状态覆盖原文件。可用备份产生恢复候选，正常启动在业务初始化前要求明确选择；默认退出。恢复复核候选字节，保留损坏原文到独立文件再替换主文件；主文件或备份变化则拒绝陈旧确认。恢复为主进程启动能力，没有额外 HTTP/IPC 入口；插件 settings 门面排除恢复函数，仍保留原有配置助手。

已有备份/主文件写入失败仍是提交失败；主文件已经成功而首次备份或迁移记录失败时，保持主写入成功并记录警告，避免把已落盘修改错误报告为未提交。辅助记录可在同进程的后续提交重试，重启前未成功补写不保证审计历史完整。运行期间的外部文件编辑没有自动重载保证；同步兼容重合并继续沿用原有补写边界。`verify:settings-recovery` 覆盖进程中断、读取/替换故障、用户恢复选择及实际 Electron/ASAR 路径，不替代断电、跨文件或安装升级验收。
