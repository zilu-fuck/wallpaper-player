import type { LibraryResponse, PairingPayload, PlaybackState, RemoteInfo, StoredDevice, VideoAnalysisResponse } from '../types'
import { joinUrl, normalizeEndpoint } from '../utils/url'
import { Platform } from 'react-native'

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

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function isAbortError(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

async function requestJson<T>(endpoint: string, path: string, options: RequestOptions = {}): Promise<T> {
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
        ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let errorData: { error?: { message?: string, code?: string } } | null = null
      try {
        errorData = text ? JSON.parse(text) : null
      } catch {
        errorData = null
      }
      const error = errorData?.error
      throw new ApiError(error?.message || `请求失败: ${response.status}`, response.status, error?.code)
    }

    if (options.raw) {
      return (await response.arrayBuffer()) as T
    }

    const text = await response.text()
    const data = text ? JSON.parse(text) : null

    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (options.signal?.aborted) {
      const abortError = new Error('请求已取消')
      abortError.name = 'AbortError'
      throw abortError
    }
    if (isAbortError(error)) {
      throw new ApiError('连接超时', 408, 'timeout')
    }
    const message = error instanceof Error ? error.message : ''
    if (/fetch|network|cancel/i.test(message)) {
      throw new ApiError('无法连接电脑。请确认手机和电脑在同一 Wi-Fi，优先使用 192.168 开头的地址，并检查 VPN/防火墙。', 0, 'network_error')
    }
    throw new ApiError(message || '网络请求失败', 0, 'network_error')
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortRequest)
  }
}

export async function claimPairing(
  endpoint: string,
  payload: PairingPayload,
  client: { clientId: string, clientName?: string } = { clientId: '' },
  signal?: AbortSignal
) {
  return requestJson<{
    status?: 'pending' | 'approved'
    pairingRequestId?: string
    deviceId: string
    deviceName: string
    endpoint?: string
    endpoints?: string[]
    token: string
    pairedDeviceId?: string
    serverVersion?: string
  }>(endpoint, '/v1/pairing/claim', {
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

export async function getInfo(endpoint: string) {
  const startedAt = Date.now()
  const info = await requestJson<RemoteInfo>(normalizeEndpoint(endpoint), '/v1/info', { timeoutMs: 3000 })
  return {
    ...info,
    latencyMs: Date.now() - startedAt
  }
}

export async function measureDownloadSpeed(endpoint: string, token: string, bytes = 1024 * 1024) {
  const startedAt = Date.now()
  try {
    const body = await requestJson<ArrayBuffer>(endpoint, `/v1/speed-test?bytes=${encodeURIComponent(String(bytes))}`, {
      token,
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
    if (error instanceof ApiError) throw error
    throw new ApiError('测速失败', 0, 'network_error')
  }
}

export async function getLibrary(device: StoredDevice) {
  return requestJson<LibraryResponse>(device.endpoint, '/v1/library', { token: device.token, timeoutMs: 15000 })
}

export async function getPlaybackState(device: StoredDevice, videoId: string) {
  return requestJson<PlaybackState | null>(device.endpoint, `/v1/playback/${encodeURIComponent(videoId)}`, {
    token: device.token,
    timeoutMs: 5000
  })
}

export async function savePlaybackState(device: StoredDevice, videoId: string, position: number) {
  return requestJson<{ success: boolean }>(device.endpoint, `/v1/playback/${encodeURIComponent(videoId)}`, {
    method: 'PUT',
    token: device.token,
    body: { position },
    timeoutMs: 5000
  })
}

export async function toggleFavorite(device: StoredDevice, videoId: string) {
  return requestJson<{ success: boolean, favorite: boolean }>(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/favorite`, {
    method: 'PUT',
    token: device.token,
    timeoutMs: 5000
  })
}

export async function updateVideoTags(device: StoredDevice, videoId: string, tags: string[]) {
  return requestJson<{ success: boolean, customTags: string[] }>(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/tags`, {
    method: 'PUT',
    token: device.token,
    body: { tags },
    timeoutMs: 5000
  })
}

export async function addTagsToVideos(device: StoredDevice, videoIds: string[], tags: string[]) {
  return requestJson<{ success: boolean, updatedCount: number, tags: string[] }>(device.endpoint, '/v1/videos/tags/bulk', {
    method: 'PUT',
    token: device.token,
    body: { videoIds, tags },
    timeoutMs: 10000
  })
}

// 还原所有隐藏标签（需隐私密码验证，电脑端清空 hiddenTags）
export async function restoreHiddenTags(device: StoredDevice, password: string) {
  return requestJson<{ success: boolean }>(device.endpoint, '/v1/tags/restore-hidden', {
    method: 'POST',
    token: device.token,
    body: { password },
    timeoutMs: 10000
  })
}

export async function startTranscode(device: StoredDevice, videoId: string, quality = 'compatible') {
  return requestJson<{ status: string, progress: number, error?: string, streamUrl?: string, queuePosition?: number }>(
    device.endpoint,
    `/v1/videos/${encodeURIComponent(videoId)}/transcode?quality=${encodeURIComponent(quality)}`,
    {
      method: 'POST',
      token: device.token,
      timeoutMs: 8000
    }
  )
}

export async function getTranscodeStatus(device: StoredDevice, videoId: string, quality = 'compatible') {
  return requestJson<{ status: string, progress: number, error?: string, streamUrl?: string, queuePosition?: number }>(
    device.endpoint,
    `/v1/videos/${encodeURIComponent(videoId)}/transcode?quality=${encodeURIComponent(quality)}`,
    {
      token: device.token,
      timeoutMs: 5000
    }
  )
}

export async function listTranscodes(device: StoredDevice) {
  return requestJson<{
    tasks: Array<{
      id: string
      quality: string
      status: string
      progress: number
      error?: string
      queuePosition?: number
      streamUrl?: string
    }>
    checkedAt: number
  }>(device.endpoint, '/v1/transcodes', {
    token: device.token,
    timeoutMs: 5000
  })
}

export async function clearTranscodeCache(device: StoredDevice, force = false) {
  return requestJson<{
    success: boolean
    removed: number
    bytesRemoved: number
    totalFiles: number
    totalBytes: number
  }>(device.endpoint, '/v1/transcodes/cache', {
    method: 'DELETE',
    token: device.token,
    body: { force },
    timeoutMs: 10000
  })
}

export async function cancelTranscode(device: StoredDevice, videoId: string, quality = 'compatible') {
  return requestJson<{ success: boolean }>(
    device.endpoint,
    `/v1/videos/${encodeURIComponent(videoId)}/transcode?quality=${encodeURIComponent(quality)}`,
    {
      method: 'DELETE',
      token: device.token,
      timeoutMs: 5000
    }
  )
}

export async function getVideoAnalysis(device: StoredDevice, videoId: string) {
  try {
    return await requestJson<VideoAnalysisResponse>(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/analysis`, {
      token: device.token,
      timeoutMs: 12000
    })
  } catch (error) {
    if (isAnalysisPluginUnavailable(error)) {
      return createUnavailableAnalysisResponse()
    }
    throw error
  }
}

export async function startVideoAnalysis(device: StoredDevice, videoId: string) {
  try {
    return await requestJson<VideoAnalysisResponse>(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/analysis`, {
      method: 'POST',
      token: device.token,
      timeoutMs: 12000
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
  return requestJson<{ success: boolean }>(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/play-on-desktop`, {
    method: 'POST',
    token: device.token,
    body: { position },
    timeoutMs: 8000
  })
}

export async function revealOnDesktop(device: StoredDevice, videoId: string) {
  return requestJson<{ success: boolean }>(device.endpoint, `/v1/videos/${encodeURIComponent(videoId)}/reveal-on-desktop`, {
    method: 'POST',
    token: device.token,
    timeoutMs: 8000
  })
}

export async function unpairCurrentDevice(device: StoredDevice) {
  return requestJson<{ success: boolean }>(device.endpoint, '/v1/devices/current', {
    method: 'DELETE',
    token: device.token,
    timeoutMs: 5000
  })
}

export function resolveRemoteUrl(device: StoredDevice, path: string) {
  return joinUrl(device.endpoint, path)
}
