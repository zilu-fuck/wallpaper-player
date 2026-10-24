import type { PairingPayload, StoredDevice, VideoAnalysisResponse, PlaybackWrite } from '../types'
import { analysisSchema, bulkTagsSchema, bulkTagsDetailedSchema, versionedPlaybackSchema, versionedPlaybackResultSchema, errorEnvelopeSchema, favoriteSchema, getHttpContract, isRetryableError, infoSchema, librarySchema, libraryPageSchema, libraryRevisionSchema, categoriesPageSchema, type LibraryPageRequest, negotiateCapabilities, pairingResultSchema, playbackResultSchema, playbackSchema, tagStateSchema, versionedTagsResultSchema, type TagWrite, s, successSchema, tagsResultSchema, taskSchema, tasksSchema, transcodeCacheSchema, type Schema } from '../../../packages/contracts'
import { joinUrl, normalizeEndpoint } from '../utils/url'
import { Platform } from 'react-native'
import { authorizationSchema, type RemoteInfo } from '../../../packages/contracts'
import { ownedTaskSchema, taskCancelSchema, ownedAnalysisSchema, analysisCancelSchema } from '../../../packages/contracts'

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** 返回原始字节而非 JSON 解析结果 */
  raw?: boolean
}

export class ApiError extends Error {
  status: number
  code?: string
  retryable: boolean
  currentRevision?: number
  currentLibraryRevision?: string

  constructor(message: string, status: number, code?: string, retryable = isRetryableError(status, code || 'http_error')) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

function isAbortError(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

async function request<T>(endpoint: string, path: string, parse: (response: Response) => Promise<T>, options: RequestOptions): Promise<T> {
  let body = options.body
  try { body = getHttpContract(options.method ?? 'GET', new URL(path, endpoint).pathname)?.request?.parse(body ?? {}, 'request') ?? body }
  catch { throw new ApiError('请求参数无效，请检查操作后重试。', 400, 'invalid_request', false) }
  const controller = new AbortController()
  const abortRequest = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', abortRequest, { once: true })
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000)
  try {
    const response = await fetch(joinUrl(endpoint, path), {
      method: options.method ?? 'GET',
      headers: {
        Accept: options.raw ? 'application/octet-stream' : 'application/json',
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: 'Bearer ' + options.token } : {})
      },
      body: body == null ? undefined : JSON.stringify(body), signal: controller.signal
    })
    if (!response.ok) {
      let details
      try { details = errorEnvelopeSchema.parse(await response.json()).error } catch { details = null }
      const error = new ApiError(details?.message || '请求失败: ' + response.status, response.status, details?.code || 'http_error', details?.retryable)
      error.currentLibraryRevision = details?.currentLibraryRevision
      error.currentRevision = details?.currentRevision
      throw error
    }
    return await parse(response)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (options.signal?.aborted) { const aborted = new Error('请求已取消'); aborted.name = 'AbortError'; throw aborted }
    if (isAbortError(error)) throw new ApiError('连接超时', 408, 'timeout')
    throw new ApiError('无法连接电脑。请确认手机和电脑在同一 Wi-Fi，并检查 VPN/防火墙。', 0, 'network_error', true)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortRequest)
  }
}

async function requestJson<T>(endpoint: string, path: string, schema: Schema<T>, options: RequestOptions = {}): Promise<T> {
  return request(endpoint, path, async response => {
    let data: unknown
    try { data = await response.json(); return schema.parse(data, 'response') }
    catch (error) {
      if (isAbortError(error)) throw error
      throw new ApiError('电脑响应格式不兼容，请更新应用或重新连接。', 502, 'invalid_response', false)
    }
  }, options)
}
function requestBytes(endpoint: string, path: string, options: RequestOptions = {}) {
  return request(endpoint, path, response => response.arrayBuffer(), { ...options, raw: true })
}

export async function claimPairing(
  endpoint: string,
  payload: PairingPayload,
  client: { clientId: string, clientName?: string } = { clientId: '' },
  signal?: AbortSignal
) {
  return requestJson(endpoint, '/v1/pairing/claim', pairingResultSchema, {
    method: 'POST',
    timeoutMs: 8000,
    signal,
    body: {
      pairingId: payload.pairingId,
      oneTimeSecret: payload.oneTimeSecret,
      clientId: client.clientId,
      clientName: client.clientName || 'Wallpaper Player Mobile',
      platform: Platform.OS
    }
  })
}

async function requestInfo(endpoint: string, signal: AbortSignal | undefined, requireCompatible: boolean) {
  const startedAt = Date.now()
  const info = await requestJson(normalizeEndpoint(endpoint), '/v1/info', infoSchema, { timeoutMs: 3000, signal })
  if (requireCompatible) {
    try { negotiateCapabilities(info) } catch { throw new ApiError('电脑要求更新版本的手机应用，请先更新。', 426, 'unsupported_protocol', false) }
  }
  return {
    ...info,
    latencyMs: Date.now() - startedAt
  }
}
export function getInfo(endpoint: string, signal?: AbortSignal) { return requestInfo(endpoint, signal, true) }
// Updating the client must remain possible when the server requires a newer client protocol.
// This still parses the same info contract; connection-manager confirms identity and authorization.
export function getUpdateServerInfo(endpoint: string, signal?: AbortSignal) { return requestInfo(endpoint, signal, false) }

export async function probeAuthorization(endpoint: string, token: string, info: RemoteInfo, signal?: AbortSignal) {
  if (!info.capabilities.authProbe) { await measureDownloadSpeed(endpoint, token, 64 * 1024, signal); return }
  const response = await requestJson(endpoint, '/v1/auth', authorizationSchema, { token, signal, timeoutMs: 3000 })
  if (response.deviceId !== info.deviceId) throw new ApiError('这个地址属于另一台电脑，请重新连接。', 409, 'device_mismatch', false)
}

export async function measureDownloadSpeed(endpoint: string, token: string, bytes = 1024 * 1024, signal?: AbortSignal) {
  const startedAt = Date.now()
  try {
    const body = await requestBytes(endpoint, `/v1/speed-test?bytes=${encodeURIComponent(String(bytes))}`, {
      token,
      signal,
      timeoutMs: 6000,
      raw: true
    })
    const elapsedMs = Math.max(Date.now() - startedAt, 1)
    const receivedBytes = body.byteLength || bytes
    return {
      bytes: receivedBytes,
      elapsedMs,
      mbps: (receivedBytes * 8) / elapsedMs / 1000
    }
  } catch (error) {
    if (signal?.aborted) { const aborted = new Error('请求已取消'); aborted.name = 'AbortError'; throw aborted }
    if (error instanceof ApiError) throw error
    throw new ApiError('测速失败', 0, 'network_error')
  }
}

export async function getLibrary(device: StoredDevice, signal?: AbortSignal) {
  return requestJson(device.endpoint, '/v1/library', librarySchema, { token: device.token, signal, timeoutMs: 15000 })
}

export async function queryLibrary(device: StoredDevice, request: LibraryPageRequest, signal?: AbortSignal) {
  return requestJson(device.endpoint, '/v1/library/query', libraryPageSchema, { method: 'POST', token: device.token,
    body: request, signal, timeoutMs: 15000 })
}
export async function getLibraryRevision(device: StoredDevice, signal?: AbortSignal) {
  return requestJson(device.endpoint, '/v1/library/revision', libraryRevisionSchema, { token: device.token, signal, timeoutMs: 5000 })
}
export async function getLibraryCategories(device: StoredDevice, type: 'custom' | 'system', cursor?: string, signal?: AbortSignal) {
  const path = '/v1/library/categories?type=' + type + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
  return requestJson(device.endpoint, path, categoriesPageSchema, { token: device.token, signal, timeoutMs: 10000 })
}

export async function getPlaybackState(device: StoredDevice, videoId: string) {
  return requestJson(device.endpoint, `/v1/playback/${encodeURIComponent(videoId)}`, s.nullable(device.capabilities?.playbackRevision ? versionedPlaybackSchema : playbackSchema), {
    token: device.token,
    timeoutMs: 5000
  })
}

export async function savePlaybackState(device: StoredDevice, videoId: string, position: number, condition?: PlaybackWrite) {
  return requestJson(device.endpoint, `/v1/playback/${encodeURIComponent(videoId)}`, device.capabilities?.playbackRevision ? versionedPlaybackResultSchema : playbackResultSchema, {
    method: 'PUT',
    token: device.token,
    body: { position, ...(device.capabilities?.playbackRevision ? condition : {}) },
    timeoutMs: 5000
  })
}

export async function toggleFavorite(device: StoredDevice, videoId: string, desired?: boolean) {
  return requestJson(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/favorite`, favoriteSchema, {
    method: 'PUT',
    token: device.token,
    body: device.capabilities?.favoriteState && typeof desired === 'boolean' ? { favorite: desired } : undefined,
    timeoutMs: 5000
  })
}

export async function updateVideoTags(device: StoredDevice, videoId: string, tags: string[], condition?: TagWrite) {
  return requestJson(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/tags`, device.capabilities?.tagRevisions ? versionedTagsResultSchema : tagsResultSchema, {
    method: 'PUT',
    token: device.token,
    body: { tags, ...(device.capabilities?.tagRevisions ? condition : {}) },
    timeoutMs: 5000
  })
}

export async function getVideoTagsState(device: StoredDevice, videoId: string) {
  return requestJson(device.endpoint, '/v1/videos/' + encodeURIComponent(videoId) + '/tags', tagStateSchema, {
    token: device.token, timeoutMs: 5000
  })
}

export async function addTagsToVideos(device: StoredDevice, videoIds: string[], tags: string[]) {
  return requestJson(device.endpoint, '/v1/videos/tags/bulk', device.capabilities?.mediaMutationResults ? bulkTagsDetailedSchema : bulkTagsSchema, {
    method: 'PUT',
    token: device.token,
    body: { videoIds, tags },
    timeoutMs: 10000
  })
}

// 还原所有隐藏标签（需隐私密码验证，电脑端清空 hiddenTags）
export async function restoreHiddenTags(device: StoredDevice, password: string) {
  return requestJson(device.endpoint, '/v1/tags/restore-hidden', successSchema, {
    method: 'POST',
    token: device.token,
    body: { password },
    timeoutMs: 10000
  })
}

function transcodeEndpoint(device: StoredDevice, videoId: string, quality: string, interestId?: string) {
  return `/v1/videos/${encodeURIComponent(videoId)}/transcode?quality=${encodeURIComponent(quality)}` +
    (device.capabilities?.taskInterests && interestId ? '&interestId=' + encodeURIComponent(interestId) : '')
}
export async function startTranscode(device: StoredDevice, videoId: string, quality = 'compatible', signal?: AbortSignal, interestId?: string) {
  return requestJson(device.endpoint, transcodeEndpoint(device, videoId, quality, interestId), device.capabilities?.taskInterests ? ownedTaskSchema : taskSchema, {
      method: 'POST',
      token: device.token,
      timeoutMs: 8000, signal
    })
}

export async function getTranscodeStatus(device: StoredDevice, videoId: string, quality = 'compatible', signal?: AbortSignal, interestId?: string) {
  return requestJson(device.endpoint, transcodeEndpoint(device, videoId, quality, interestId), device.capabilities?.taskInterests ? ownedTaskSchema : taskSchema, {
      token: device.token,
      timeoutMs: 5000, signal
    })
}

export async function listTranscodes(device: StoredDevice) {
  return requestJson(device.endpoint, '/v1/transcodes', tasksSchema, {
    token: device.token,
    timeoutMs: 5000
  })
}

export async function clearTranscodeCache(device: StoredDevice, force = false) {
  return requestJson(device.endpoint, '/v1/transcodes/cache', transcodeCacheSchema, {
    method: 'DELETE',
    token: device.token,
    body: { force },
    timeoutMs: 10000
  })
}

export async function cancelTranscode(device: StoredDevice, videoId: string, quality = 'compatible', interestId?: string) {
  if (device.capabilities?.taskInterests && !interestId) throw new ApiError('任务订阅标识缺失，请重新载入播放器', 400, 'task_interest_required', false)
  return requestJson(device.endpoint, transcodeEndpoint(device, videoId, quality, interestId), taskCancelSchema, {
      method: 'DELETE',
      token: device.token,
      timeoutMs: 5000
    })
}

function analysisEndpoint(device: StoredDevice, videoId: string, interestId?: string) {
  return `/v1/videos/${encodeURIComponent(videoId)}/analysis` +
    (device.capabilities?.analysisInterests && interestId ? '?interestId=' + encodeURIComponent(interestId) : '')
}

export async function getVideoAnalysis(device: StoredDevice, videoId: string, signal?: AbortSignal, interestId?: string) {
  try {
    return await requestJson(device.endpoint, analysisEndpoint(device, videoId, interestId), device.capabilities?.analysisInterests ? ownedAnalysisSchema : analysisSchema, {
      token: device.token,
      timeoutMs: 12000, signal
    })
  } catch (error) {
    if (isAnalysisPluginUnavailable(error)) {
      return createUnavailableAnalysisResponse()
    }
    throw error
  }
}

export async function startVideoAnalysis(device: StoredDevice, videoId: string, signal?: AbortSignal, interestId?: string) {
  try {
    return await requestJson(device.endpoint, analysisEndpoint(device, videoId, interestId), device.capabilities?.analysisInterests ? ownedAnalysisSchema : analysisSchema, {
      method: 'POST',
      token: device.token,
      timeoutMs: 12000, signal
    })
  } catch (error) {
    if (isAnalysisPluginUnavailable(error)) {
      return {
        ...createUnavailableAnalysisResponse(),
        accepted: false
      }
    }
    throw error
  }
}

export async function cancelVideoAnalysis(device: StoredDevice, videoId: string, interestId?: string, jobId?: string) {
  if (!device.capabilities?.analysisInterests) throw new ApiError('当前电脑不支持独立取消分析，请更新电脑端', 400, 'unsupported_capability', false)
  if (!interestId) throw new ApiError('分析订阅标识缺失，请重新开始分析', 400, 'task_interest_required', false)
  const endpoint = analysisEndpoint(device, videoId, interestId) + (jobId ? '&jobId=' + encodeURIComponent(jobId) : '')
  return requestJson(device.endpoint, endpoint, analysisCancelSchema, { method: 'DELETE', token: device.token, timeoutMs: 5000 })
}

function isAnalysisPluginUnavailable(error: unknown) {
  return error instanceof ApiError && error.status === 404 && error.code === 'not_found'
}

function createUnavailableAnalysisResponse(): VideoAnalysisResponse {
  return {
    enabled: false,
    analysis: {
      available: false,
      reason: 'plugin_unavailable'
    },
    job: null,
    recent: null,
    checkedAt: Date.now(),
    reason: 'plugin_unavailable',
    error: '视频分析插件未启用或未安装，请在电脑端插件管理中启用。'
  }
}

export async function playOnDesktop(device: StoredDevice, videoId: string, position = 0) {
  return requestJson(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/play-on-desktop`, successSchema, {
    method: 'POST',
    token: device.token,
    body: { position },
    timeoutMs: 8000
  })
}

export async function revealOnDesktop(device: StoredDevice, videoId: string) {
  return requestJson(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/reveal-on-desktop`, successSchema, {
    method: 'POST',
    token: device.token,
    timeoutMs: 8000
  })
}

export async function unpairCurrentDevice(device: StoredDevice) {
  return requestJson(device.endpoint, '/v1/devices/current', successSchema, {
    method: 'DELETE',
    token: device.token,
    timeoutMs: 5000
  })
}

export function resolveRemoteUrl(device: StoredDevice, path: string) {
  return joinUrl(device.endpoint, path)
}
