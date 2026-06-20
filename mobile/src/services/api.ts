import type { LibraryResponse, PairingPayload, PlaybackState, RemoteInfo, StoredDevice } from '../types'
import { joinUrl, normalizeEndpoint } from '../utils/url'
import { Platform } from 'react-native'

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  token?: string
  timeoutMs?: number
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
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000)

  try {
    const response = await fetch(joinUrl(endpoint, path), {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })

    const text = await response.text()
    const data = text ? JSON.parse(text) : null

    if (!response.ok) {
      const error = data?.error
      throw new ApiError(error?.message || `请求失败: ${response.status}`, response.status, error?.code)
    }

    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
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
  }
}

export async function claimPairing(
  endpoint: string,
  payload: PairingPayload,
  client: { clientId: string, clientName?: string } = { clientId: '' }
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  const startedAt = Date.now()

  try {
    const response = await fetch(joinUrl(endpoint, `/v1/speed-test?bytes=${encodeURIComponent(String(bytes))}`), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream'
      },
      signal: controller.signal
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let data: { error?: { message?: string, code?: string } } | null = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      const error = data?.error
      throw new ApiError(error?.message || `测速失败: ${response.status}`, response.status, error?.code)
    }

    const body = await response.arrayBuffer()
    const elapsedMs = Math.max(Date.now() - startedAt, 1)
    const receivedBytes = body.byteLength || bytes
    return {
      bytes: receivedBytes,
      elapsedMs,
      mbps: (receivedBytes * 8) / elapsedMs / 1000
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (isAbortError(error)) {
      throw new ApiError('测速超时', 408, 'timeout')
    }
    throw new ApiError('测速失败', 0, 'network_error')
  } finally {
    clearTimeout(timeout)
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

export async function startTranscode(device: StoredDevice, videoId: string, quality = 'compatible') {
  return requestJson<{ status: string, progress: number, error?: string, streamUrl?: string }>(
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
  return requestJson<{ status: string, progress: number, error?: string, streamUrl?: string }>(
    device.endpoint,
    `/v1/videos/${encodeURIComponent(videoId)}/transcode?quality=${encodeURIComponent(quality)}`,
    {
      token: device.token,
      timeoutMs: 5000
    }
  )
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
