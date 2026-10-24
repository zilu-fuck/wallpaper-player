import { ContractError, jsonSchema, s, type Infer, type Schema } from './schema'
import { settingsVersionSchema } from './settings-feed'
export { ContractError, s, jsonSchema } from './schema'
export type { Infer, Schema } from './schema'
export * from './settings-feed'
export const PROTOCOL_VERSION = 2
export const MIN_CLIENT_PROTOCOL = 1
const optional = s.optional
const id = s.string(1024, 1)
const locator = s.string(65536, 1)
const text = s.string(20000)
const tags = s.array(s.string(1024, 1), 500)
const nonnegative = s.number(0)
const httpEndpoint = s.refine(s.string(16384, 1), value => /^https?:\/\//i.test(value), '必须是 HTTP 或 HTTPS 地址')
const mediaUrl = s.refine(s.string(32768), value => !value || value.startsWith('/v1/') || /^https?:\/\//i.test(value), '必须是支持的媒体地址')
export const capabilitiesSchema = s.object({
  favoriteState: s.default(s.boolean, false), mediaMutationResults: s.default(s.boolean, false),
  playbackRevision: s.default(s.boolean, false), libraryQuery: s.default(s.boolean, false),
  tagRevisions: s.default(s.boolean, false),
  authProbe: s.default(s.boolean, false),
  taskInterests: s.default(s.boolean, false),
  analysisInterests: s.default(s.boolean, false),
  libraryRevision: s.default(s.boolean, false), cursorPagination: s.default(s.boolean, false)
})
export type Capabilities = Infer<typeof capabilitiesSchema>
export const infoSchema = s.object({
  deviceId: id, deviceName: text, version: optional(s.integer(1)), serverVersion: optional(text),
  protocolVersion: s.default(s.integer(1), 1), minClientProtocol: s.default(s.integer(1), 1),
  capabilities: s.default(capabilitiesSchema, capabilitiesSchema.parse({})),
  endpoint: optional(httpEndpoint), endpoints: optional(s.array(httpEndpoint, 32)), latencyMs: optional(nonnegative)
}, true)
export type RemoteInfo = Infer<typeof infoSchema>
export const authorizationSchema = s.object({ authorized: s.literal(true), deviceId: id })
export function negotiateCapabilities(info: RemoteInfo): Capabilities {
  if (info.minClientProtocol > PROTOCOL_VERSION) {
    const error = new ContractError('protocolVersion', '低于电脑所需版本，请更新手机应用')
    error.code = 'unsupported_protocol'; error.status = 426; throw error
  }
  return info.capabilities
}
export const pairingPayloadSchema = s.object({ version: s.integer(1), deviceId: id, deviceName: text,
  endpoint: httpEndpoint, endpoints: optional(s.array(httpEndpoint, 32)), pairingId: optional(id),
  oneTimeSecret: optional(id), expiresAt: optional(nonnegative), token: optional(id) }, true)
export type PairingPayload = Infer<typeof pairingPayloadSchema>
const pairingBase = { deviceId: id, deviceName: text, endpoint: optional(httpEndpoint), endpoints: optional(s.array(httpEndpoint, 32)) }
export const pairingClaimSchema = s.object({ pairingId: id, oneTimeSecret: id,
  clientId: optional(s.string(80, 1)), clientName: optional(s.string(80)), platform: optional(s.string(40)) })
export const pairingResultSchema = s.union(
  s.object({ ...pairingBase, status: s.literal('pending'), pairingRequestId: id, expiresAt: optional(nonnegative) }, true),
  s.object({ ...pairingBase, status: optional(s.literal('approved')), token: id, pairedDeviceId: optional(id), serverVersion: optional(text) }, true)
)
export const mediaSchema = s.object({ available: optional(s.boolean), durationSeconds: optional(nonnegative),
  width: optional(nonnegative), height: optional(nonnegative), fps: optional(nonnegative), bitRate: optional(nonnegative),
  videoCodec: optional(text), audioCodec: optional(text), container: optional(text) }, true)
export const videoSchema = s.object({ id, name: text, fileName: optional(text),
  sourceType: optional(s.enum(['local', 'network'])), resourceKind: optional(s.enum(['direct', 'webpage'])),
  extension: text, size: nonnegative, modified: optional(nonnegative), group: optional(text),
  tags: optional(tags), systemTags: optional(tags), customTags: optional(tags), favorite: optional(s.boolean),
  customTagsRevision: optional(s.integer()),
  directoryId: optional(text), directoryName: optional(text), thumbnailUrl: mediaUrl,
  thumbnailToken: optional(text), streamUrl: mediaUrl, media: optional(s.nullable(mediaSchema)),
  network: optional(s.nullable(s.object({ site: optional(text), episodeIndex: optional(s.nullable(nonnegative)),
    episodeTitle: optional(text), parser: optional(text), kind: optional(text) }, true))) }, true)
export type VideoItem = Infer<typeof videoSchema>
export const directorySchema = s.object({ id, name: text, count: s.integer() })
export type DirectorySummary = Infer<typeof directorySchema>
export const categorySchema = s.object({ key: id, name: text, count: s.integer(), type: s.enum(['custom', 'system']) })
export type CategorySummary = Infer<typeof categorySchema>
export const queryTagSchema = s.object({ type: s.enum(['custom', 'system']), name: s.string(1024, 1) })
export const libraryQuerySchema = s.object({ directoryId: optional(id), favorite: optional(s.boolean),
  includeTags: s.default(s.array(queryTagSchema, 32), []), excludeTags: s.default(s.array(queryTagSchema, 32), []),
  query: s.default(s.string(1000), ''), sort: s.default(s.enum(['name', 'date', 'size', 'type']), 'name') })
export type LibraryQuery = Infer<typeof libraryQuerySchema>
export const libraryPageRequestSchema = s.object({ ...{
  directoryId: optional(id), favorite: optional(s.boolean), includeTags: optional(s.array(queryTagSchema, 32)),
  excludeTags: optional(s.array(queryTagSchema, 32)), query: optional(s.string(1000)),
  sort: optional(s.enum(['name', 'date', 'size', 'type'])) }, limit: s.default(s.integer(1, 500), 200), cursor: optional(s.string(2048, 1)) })
export type LibraryPageRequest = Infer<typeof libraryPageRequestSchema>
export const librarySchema = s.object({ items: s.array(videoSchema), count: s.integer(),
  directories: optional(s.array(directorySchema)), favoriteCount: optional(s.integer()), hiddenTagCount: optional(s.integer()),
  categoryGroups: optional(s.object({ custom: s.array(categorySchema), system: s.array(categorySchema) })),
  pagination: optional(s.object({ offset: s.integer(), limit: s.integer(), total: s.integer(), returned: s.integer(), hasMore: s.boolean })),
  scannedAt: optional(nonnegative), indexed: optional(s.boolean), refreshing: optional(s.boolean),
  matchedCount: optional(s.integer()), revision: optional(s.string(120, 1)), nextCursor: optional(s.nullable(s.string(2048, 1))),
  aggregationScope: optional(s.literal('visible-library')), scanState: optional(s.enum(['ready', 'refreshing'])),
  categoryPagination: optional(s.object({ customTotal: s.integer(), systemTotal: s.integer(),
    customNextCursor: s.nullable(s.string(2048, 1)), systemNextCursor: s.nullable(s.string(2048, 1)) })) }, true)
export type LibraryResponse = Infer<typeof librarySchema>
export const libraryPageSchema = s.refine(librarySchema, value => value.revision !== undefined && value.matchedCount !== undefined &&
  value.nextCursor !== undefined && value.aggregationScope !== undefined, '缺少分页查询版本或匹配数量')
export const libraryRevisionSchema = s.object({ revision: s.string(120, 1), count: s.integer(), scanState: s.enum(['ready', 'refreshing']) })
export const categoriesPageSchema = s.object({ items: s.array(categorySchema, 500), count: s.integer(),
  nextCursor: s.nullable(s.string(2048, 1)), revision: s.string(120, 1), aggregationScope: s.literal('visible-library') })
export const playbackSchema = s.object({ position: nonnegative, updatedAt: optional(nonnegative), revision: optional(s.integer()),
  writer: optional(s.object({ session: s.integer(1), sequence: s.integer(1) })) }, true)
export type PlaybackState = Infer<typeof playbackSchema>
export const playbackWriteSchema = s.object({ baseRevision: s.integer(), session: s.integer(1), sequence: s.integer(1) })
export type PlaybackWrite = Infer<typeof playbackWriteSchema>
const playbackRequestBase = s.object({ position: nonnegative, baseRevision: optional(s.integer()),
  session: optional(s.integer(1)), sequence: optional(s.integer(1)) })
export const playbackRequestSchema = s.refine(playbackRequestBase, value =>
  [value.baseRevision, value.session, value.sequence].every(item => item === undefined) ||
  [value.baseRevision, value.session, value.sequence].every(item => item !== undefined), '播放进度版本必须完整')
export const successSchema = s.object({ success: s.boolean }, true)
export const favoriteRequestSchema = s.object({ favorite: optional(s.boolean) })
export const favoriteSchema = s.object({ success: s.boolean, favorite: s.boolean }, true)
export const tagWriteSchema = s.object({ expectedRevision: s.integer(), operationId: s.string(120, 1) })
export type TagWrite = Infer<typeof tagWriteSchema>
export const tagsRequestSchema = s.refine(s.object({ tags: optional(tags), expectedRevision: optional(s.integer()), operationId: optional(s.string(120, 1)) }),
  value => (value.expectedRevision === undefined) === (value.operationId === undefined), '标签版本与操作编号必须完整')
export const tagStateSchema = s.object({ customTags: tags, customTagsRevision: s.integer() }, true)
export const tagsResultSchema = s.object({ success: s.boolean, customTags: tags, customTagsRevision: optional(s.integer()),
  operationRevision: optional(s.integer()), replayed: optional(s.boolean) }, true)
export const versionedTagsResultSchema = s.refine(tagsResultSchema, value => value.customTagsRevision !== undefined, '缺少标签版本')
export const bulkTagsRequestSchema = s.object({ videoIds: optional(s.array(id, 10000)), tags: optional(tags) })
export const mutationFailureSchema = s.object({ id: optional(locator), index: s.integer(), code: id, message: text })
export const mutationUpdatedSchema = s.object({ id: optional(locator), index: s.integer(), customTags: tags, customTagsRevision: optional(s.integer()) }, true)
export const bulkTagsSchema = s.refine(s.object({ success: s.boolean, updatedCount: s.integer(), tags,
  updated: optional(s.array(s.object({ id, index: s.integer(), customTags: tags, customTagsRevision: optional(s.integer()) }), 10000)),
  failed: optional(s.array(s.object({ id, index: s.integer(), code: id, message: text }), 10000)) }, true),
  value => !value.updated || value.updated.length === value.updatedCount, '批量结果数量不一致')
export type BulkTagsResult = Infer<typeof bulkTagsSchema>
export const bulkTagsDetailedSchema = s.refine(bulkTagsSchema, value => Array.isArray(value.updated) && Array.isArray(value.failed),
  '必须包含逐项成功和失败结果')
export const playbackResultSchema = s.object({ success: s.boolean, playback: optional(playbackSchema) }, true)
export const versionedPlaybackSchema = s.refine(playbackSchema, value => value.revision !== undefined, '缺少播放进度版本')
export const versionedPlaybackResultSchema = s.refine(playbackResultSchema,
  value => Boolean(value.playback && value.playback.revision !== undefined), '缺少已提交进度及版本')
export const taskSchema = s.object({ id: optional(id), quality: optional(text),
  status: s.enum(['queued', 'running', 'ready', 'error', 'cancelled']), progress: s.number(0, 1),
  error: optional(text), streamUrl: optional(mediaUrl), queuePosition: optional(s.integer()),
  createdAt: optional(nonnegative), updatedAt: optional(nonnegative),
  interestId: optional(s.string(128, 1)), canCancel: optional(s.boolean), interestedClients: optional(s.integer()),
  taskId: optional(id), operation: optional(s.enum(['remux', 'reencode'])) }, true)
export type TaskStatus = Infer<typeof taskSchema>
export const taskCancelSchema = s.object({ success: s.boolean, released: optional(s.boolean),
  taskCancelled: optional(s.boolean), shared: optional(s.boolean) }, true)
export const ownedTaskSchema = s.refine(taskSchema, value => value.interestId !== undefined &&
  value.canCancel !== undefined && value.interestedClients !== undefined, '缺少任务订阅状态')
export const tasksSchema = s.object({ tasks: s.array(taskSchema, 10000), checkedAt: nonnegative })
export const transcodeCacheSchema = s.object({ success: s.boolean, removed: s.integer(), bytesRemoved: nonnegative,
  totalFiles: s.integer(), totalBytes: nonnegative }, true)
export const analysisResultSchema = s.object({ available: s.boolean, reason: optional(text), error: optional(text),
  savedAt: optional(text), matchType: optional(text), summary: optional(text), tags: optional(tags), keywords: optional(tags),
  sourceVideo: optional(s.object({ original_filename: optional(text), duration: optional(nonnegative), file_size_bytes: optional(nonnegative) }, true)),
  timeline: optional(s.array(s.object({ start_time: nonnegative, end_time: nonnegative, title: optional(text), description: optional(text),
    confidence: optional(s.number()), vlm_status: optional(text) }, true))),
  characters: optional(s.array(s.object({ name: optional(text), identity_status: optional(text), description: optional(text), confidence: optional(s.number()) }, true))),
  quality: optional(s.record(jsonSchema)), naming: optional(s.object({ episode_title: optional(text) }, true)) }, true)
export const analysisEventSchema = s.object({ type: optional(text), stage: optional(text), status: optional(text),
  message: optional(text), createdAt: optional(text) }, true)
export const analysisJobSchema = s.object({ running: s.boolean, currentVideo: s.boolean, jobId: optional(text),
  interestId: optional(s.string(128, 1)), canCancel: optional(s.boolean), interestedClients: optional(s.integer()), interestCancelled: optional(s.boolean),
  startedAt: optional(nonnegative), lastEvent: optional(s.nullable(analysisEventSchema)) }, true)
export const analysisRecentSchema = s.object({ jobId: optional(text), status: optional(text), message: optional(text), error: optional(text),
  updatedAt: optional(nonnegative), event: optional(s.nullable(analysisEventSchema)), analysis: optional(s.nullable(analysisResultSchema)) }, true)
export const analysisSchema = s.object({ enabled: s.boolean, analysis: s.nullable(analysisResultSchema), job: s.nullable(analysisJobSchema),
  recent: s.nullable(analysisRecentSchema), checkedAt: nonnegative, accepted: optional(s.boolean), reason: optional(text), error: optional(text) }, true)
export const ownedAnalysisSchema = s.refine(analysisSchema, value => !value.job || (value.job.interestId !== undefined &&
  value.job.canCancel !== undefined && value.job.interestedClients !== undefined && value.job.interestCancelled !== undefined &&
  (!value.job.canCancel || (value.job.running && value.job.currentVideo && !value.job.interestCancelled && value.job.interestedClients > 0))), '分析订阅状态缺失或矛盾')
export const analysisCancelSchema = s.object({ success: s.boolean, released: s.boolean, taskCancelled: s.boolean, shared: s.boolean,
  cancelled: optional(s.boolean), jobId: optional(text), reason: optional(text) }, true)
export type VideoAnalysisResult = Infer<typeof analysisResultSchema>
export type VideoAnalysisTimelineItem = NonNullable<VideoAnalysisResult['timeline']>[number]
export type VideoAnalysisCharacter = NonNullable<VideoAnalysisResult['characters']>[number]
export type VideoAnalysisEvent = Infer<typeof analysisEventSchema>
export type VideoAnalysisJob = Infer<typeof analysisJobSchema>
export type VideoAnalysisRecentEvent = Infer<typeof analysisRecentSchema>
export type VideoAnalysisResponse = Infer<typeof analysisSchema>
export const errorEnvelopeSchema = s.object({ error: s.object({ code: id, message: text,
  retryable: optional(s.boolean), currentRevision: optional(s.integer()), currentLibraryRevision: optional(s.string(120, 1)) }, true) })
export type ServiceError = Infer<typeof errorEnvelopeSchema>['error']
export function isRetryableError(status: number, code: string): boolean {
  return !['invalid_response', 'unsupported_protocol'].includes(code) &&
    (code === 'network_error' || status === 408 || status === 429 || status >= 500)
}
export function errorDetails(status: number, code: string, message: string, currentRevision?: number, currentLibraryRevision?: string): ServiceError {
  return { code, message, retryable: isRetryableError(status, code),
    ...(currentRevision == null ? {} : { currentRevision }),
    ...(currentLibraryRevision == null ? {} : { currentLibraryRevision }) }
}

export const qualitySchema = s.enum(['compatible', '1080p', '720p', '480p'])
export function validateHttpQuery(method: string, url: URL) {
  if (method === 'GET' && url.pathname === '/v1/library') {
    for (const key of ['offset', 'limit']) {
      const value = url.searchParams.get(key)
      if (value != null) s.integer().parse(Number(value), `query.${key}`)
    }
  }
  if (/^\/v1\/videos\/[^/]+\/(transcode|transcoded-stream)$/.test(url.pathname)) {
    qualitySchema.parse((url.searchParams.get('quality') || 'compatible').trim().toLowerCase(), 'query.quality')
    if (url.searchParams.has('interestId')) s.refine(s.string(128, 1), value => /^[A-Za-z0-9_-]+$/.test(value), '任务订阅 ID 无效')
      .parse(url.searchParams.get('interestId'), 'query.interestId')
  }
}

export interface HttpContract { request?: Schema<unknown>, response: Schema<unknown> }
export function getHttpContract(method: string, pathname: string): HttpContract | undefined {
  if (method === 'GET' && pathname === '/v1/info') return { response: infoSchema }
  if (method === 'GET' && pathname === '/v1/auth') return { response: authorizationSchema }
  if (method === 'POST' && pathname === '/v1/pairing/claim') return { request: pairingClaimSchema, response: pairingResultSchema }
  if (method === 'GET' && pathname === '/v1/library') return { response: librarySchema }
  if (method === 'POST' && pathname === '/v1/library/query') return { request: libraryPageRequestSchema, response: libraryPageSchema }
  if (method === 'GET' && pathname === '/v1/library/revision') return { response: libraryRevisionSchema }
  if (method === 'GET' && pathname === '/v1/library/categories') return { response: categoriesPageSchema }
  if (method === 'GET' && /^\/v1\/playback\/[^/]+$/.test(pathname)) return { response: s.nullable(versionedPlaybackSchema) }
  if (method === 'PUT' && /^\/v1\/playback\/[^/]+$/.test(pathname)) return { request: playbackRequestSchema, response: versionedPlaybackResultSchema }
  if (method === 'PUT' && /^\/v1\/videos\/[^/]+\/favorite$/.test(pathname)) return { request: favoriteRequestSchema, response: favoriteSchema }
  if (method === 'PUT' && pathname === '/v1/videos/tags/bulk') return { request: bulkTagsRequestSchema, response: bulkTagsDetailedSchema }
  if (method === 'PUT' && /^\/v1\/videos\/[^/]+\/tags$/.test(pathname)) return { request: tagsRequestSchema, response: tagsResultSchema }
  if (method === 'GET' && /^\/v1\/videos\/[^/]+\/tags$/.test(pathname)) return { response: tagStateSchema }
  if (method === 'POST' && pathname === '/v1/tags/restore-hidden') return { request: s.object({ password: optional(text) }), response: successSchema }
  if (method === 'POST' && /^\/v1\/videos\/[^/]+\/play-on-desktop$/.test(pathname)) return { request: s.object({ position: optional(nonnegative) }), response: successSchema }
  if (method === 'POST' && /^\/v1\/videos\/[^/]+\/reveal-on-desktop$/.test(pathname)) return { response: successSchema }
  if (method === 'DELETE' && pathname === '/v1/devices/current') return { response: successSchema }
  if (/^\/v1\/videos\/[^/]+\/transcode$/.test(pathname)) return { response: method === 'DELETE' ? taskCancelSchema : taskSchema }
  if (method === 'GET' && pathname === '/v1/transcodes') return { response: tasksSchema }
  if (method === 'DELETE' && pathname === '/v1/transcodes/cache') return { request: s.object({ force: optional(s.boolean) }), response: transcodeCacheSchema }
  if ((method === 'GET' || method === 'POST') && /^\/v1\/videos\/[^/]+\/analysis$/.test(pathname)) return { response: analysisSchema }
  if (method === 'DELETE' && /^\/v1\/videos\/[^/]+\/analysis$/.test(pathname)) return { response: analysisCancelSchema }
  if (method === 'GET' && /^\/v1\/videos\/[^/]+\/metadata$/.test(pathname)) return { response: s.object({ media: mediaSchema, checkedAt: nonnegative }) }
  return undefined
}

export const desktopTargetSchema = s.union(locator, s.refine(s.object({ id: optional(locator), fullPath: optional(locator), url: optional(locator),
  sourceType: optional(s.enum(['local', 'network'])), favoriteKey: optional(locator) }, true),
  value => Boolean(value.id || value.fullPath || value.url), '缺少媒体目标'))
export type MediaMutationTarget = Infer<typeof desktopTargetSchema>
export const desktopPlaybackPatchSchema = s.object({ position: optional(nonnegative), updatedAt: optional(nonnegative), volume: optional(s.number(0, 100)),
  speed: optional(s.number(Number.MIN_VALUE)), muted: optional(s.boolean), audioId: optional(s.nullable(s.number())), subtitleId: optional(s.nullable(s.number())),
  subtitleVisible: optional(s.boolean), subtitleScale: optional(s.number(Number.MIN_VALUE)), loopMode: optional(s.enum(['off', 'inf', 'a-b'])),
  abLoopA: optional(s.nullable(nonnegative)), abLoopB: optional(s.nullable(nonnegative)) })
export type DesktopPlaybackPatch = Infer<typeof desktopPlaybackPatchSchema>
export const ipcFailureSchema = s.object({ success: s.literal(false), error: text, code: optional(text), retryable: optional(s.boolean), currentRevision: optional(s.integer()) }, true)
const ipcSettings = { settings: optional(s.record(jsonSchema)), settingsVersion: optional(settingsVersionSchema) }
export const ipcFavoriteSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true), favorite: s.boolean, favoriteKey: optional(locator), ...ipcSettings }, true))
export const ipcTagsSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true), customTags: tags, favoriteKey: optional(locator),
  customTagsRevision: s.integer(), operationRevision: optional(s.integer()), replayed: optional(s.boolean), ...ipcSettings }, true))
export const legacyIpcTagsSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true), customTags: tags, favoriteKey: optional(locator),
  customTagsRevision: optional(s.integer()), operationRevision: optional(s.integer()), replayed: optional(s.boolean), ...ipcSettings }, true))
export const ipcTagStateSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true), customTags: tags,
  customTagsRevision: s.integer(), tagRevisionKey: optional(id), ...ipcSettings }, true))
export const ipcBulkTagsSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true), updatedCount: s.integer(), tags,
  updated: s.array(mutationUpdatedSchema, 10000), failed: s.array(mutationFailureSchema, 10000), ...ipcSettings }, true))
export const ipcPlaybackResultSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true) }, true))
export const ipcPlaybackSchema = s.nullable(s.object({ position: nonnegative, updatedAt: optional(nonnegative), volume: optional(s.number(0, 100)),
  speed: optional(s.number(Number.MIN_VALUE)), muted: optional(s.boolean), revision: optional(s.integer()) }, true))
export const desktopVideoSchema = s.object({ fullPath: locator, name: text, fileName: text, extension: text, size: nonnegative,
  favoriteKey: optional(locator), id: optional(locator), tags: optional(tags), group: optional(text), modified: optional(nonnegative) }, true)
export const ipcScanSchema = s.union(s.object({ error: text }, true), s.object({ videos: s.array(desktopVideoSchema),
  directory: optional(text), totalCount: optional(s.integer()), indexed: optional(s.boolean), refreshing: optional(s.boolean) }, true))

const playerSessionId = s.string(128, 1)
export const mediaRequestIdSchema = s.refine(s.string(128, 1), value => /^[A-Za-z0-9_-]+$/.test(value), '媒体请求编号无效')
export const metadataOptionsSchema = s.object({ force: optional(s.boolean), requestId: optional(mediaRequestIdSchema) })
export const playerBoundsSchema = s.object({ x: s.number(-100000, 100000), y: s.number(-100000, 100000),
  width: s.number(1, 100000), height: s.number(1, 100000) })
export const playerCommandSchema = s.union(
  s.object({ command: s.enum(['seekTo', 'seekRelative', 'setVolume', 'setSpeed', 'setSubtitleScale']), value: s.number() }),
  s.object({ command: s.enum(['setPaused', 'setMuted', 'setSubtitleVisible']), value: s.boolean }),
  s.object({ command: s.enum(['setAudioTrack', 'setSubtitleTrack']), value: s.union(s.number(), s.literal('no'), s.literal('auto'), s.literal('off'), s.literal(null)) }),
  s.object({ command: s.literal('setLoopMode'), value: s.enum(['off', 'inf', 'a-b']) }),
  s.object({ command: s.literal('setABLoop'), start: nonnegative, end: nonnegative }),
  s.object({ command: s.enum(['cyclePause', 'toggleMute', 'cycleSpeed', 'cycleAudioTrack', 'cycleSubtitleTrack',
    'toggleSubtitleVisible', 'clearABLoop', 'screenshot']) })
)
export type PlayerCommand = Infer<typeof playerCommandSchema>
export const playerActionSchema = s.union(
  s.object({ action: s.literal('load'), sessionId: playerSessionId, target: locator, source: s.enum(['local', 'network']),
    resume: optional(s.boolean), hostBounds: optional(playerBoundsSchema), title: optional(text),
    temporary: optional(s.boolean), kind: optional(s.enum(['direct', 'webpage'])),
    playlist: optional(s.array(locator, 10000)), playlistIndex: optional(s.integer(0, 9999)) }),
  s.object({ action: s.enum(['stop', 'state']), sessionId: playerSessionId }),
  s.object({ action: s.literal('bounds'), sessionId: playerSessionId, bounds: playerBoundsSchema }),
  s.object({ action: s.literal('command'), sessionId: playerSessionId, command: playerCommandSchema })
)
export type PlayerAction = Infer<typeof playerActionSchema>
export const playerNativeStateSchema = s.object({ filePath: s.nullable(locator), resourceTarget: optional(locator),
  sessionId: s.string(128), engineSessionId: s.integer(), timePos: nonnegative, duration: nonnegative,
  paused: s.boolean, ready: s.boolean, volume: s.number(0, 100), muted: s.boolean, speed: s.number(Number.MIN_VALUE),
  eofReached: s.boolean, buffering: s.default(s.boolean, false), trackList: s.array(s.record(jsonSchema), 1000) }, true)
export type PlayerNativeState = Infer<typeof playerNativeStateSchema>
export const playerActionResultSchema = s.union(ipcFailureSchema, s.object({ success: s.literal(true), sessionId: playerSessionId,
  state: optional(playerNativeStateSchema), screenshotPath: optional(locator), webpageUrl: optional(httpEndpoint) }, true))
export type PlayerActionResult = Infer<typeof playerActionResultSchema>
export function parseMediaMutationArgs(method: string, args: unknown[]): unknown[] {
  if (method === 'getVideoTags') return [desktopTargetSchema.parse(args[0])]
  if (method === 'setFavorite') return [desktopTargetSchema.parse(args[0]), optional(s.boolean).parse(args[1])]
  if (method === 'setVideoTags') return [desktopTargetSchema.parse(args[0]), tags.parse(args[1]), optional(tagWriteSchema).parse(args[2])]
  if (method === 'appendTagsBulk') return [s.array(desktopTargetSchema, 10000).parse(args[0]), tags.parse(args[1])]
  throw new ContractError('method', '不受支持')
}
export function mediaMutationResultSchema(method: string): Schema<unknown> {
  if (method === 'getVideoTags') return ipcTagStateSchema
  if (method === 'setFavorite') return ipcFavoriteSchema
  if (method === 'setVideoTags') return ipcTagsSchema
  if (method === 'appendTagsBulk') return ipcBulkTagsSchema
  throw new ContractError('method', '不受支持')
}
