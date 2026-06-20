import { ApiError, getInfo, measureDownloadSpeed } from './api'
import { saveDevice } from '../stores/devices'
import type { StoredDevice } from '../types'
import { normalizeEndpoint } from '../utils/url'

type ConnectionProgress = {
  progress: number
  title: string
  detail: string
}

type ProgressCallback = (progress: ConnectionProgress) => void

export type DeviceAvailability = {
  state: 'online' | 'offline' | 'unauthorized' | 'mismatch'
  text: string
  endpoint?: string
}

function uniqueEndpoints(...groups: Array<string | string[] | undefined>) {
  const seen = new Set<string>()
  return groups
    .flatMap(group => Array.isArray(group) ? group : [group])
    .filter((value): value is string => Boolean(value?.trim()))
    .map(value => normalizeEndpoint(value))
    .filter(value => {
      if (!value || seen.has(value)) return false
      seen.add(value)
      return true
    })
}

function isAuthError(error: unknown) {
  return error instanceof ApiError && (
    error.status === 401 ||
    error.status === 403 ||
    error.code === 'unauthorized' ||
    error.code === 'legacy_token_disabled'
  )
}

function authErrorMessage(error: ApiError) {
  if (error.status === 403 || error.code === 'legacy_token_disabled') {
    return '电脑端已关闭旧版 Token 入口，请使用二维码/绑定码重新绑定，或在电脑端开启“兼容旧版手动 Token”。'
  }
  return '这台电脑已取消当前手机的授权，请重新扫码绑定。'
}

async function findBestEndpoint(device: StoredDevice, onProgress?: ProgressCallback) {
  const candidates = uniqueEndpoints(device.endpoint, device.endpoints)
  onProgress?.({
    progress: 0.22,
    title: '正在查找电脑',
    detail: '正在检查已保存的局域网地址...'
  })
  const attempts = await Promise.all(candidates.map(async (endpoint) => {
    try {
      const info = await getInfo(endpoint)
      return { endpoint, info }
    } catch {
      return null
    }
  }))

  const matches = attempts
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter(item => !device.id || !item.info.deviceId || item.info.deviceId === device.id)

  if (!matches.length) {
    onProgress?.({
      progress: 0.32,
      title: '正在重新连接',
      detail: '正在尝试上次可用地址...'
    })
    const info = await getInfo(device.endpoint)
    if (device.id && info.deviceId && info.deviceId !== device.id) {
      throw new ApiError('这个地址属于另一台电脑，请返回设备列表重新选择或扫码绑定。', 409, 'device_mismatch')
    }
    await measureDownloadSpeed(device.endpoint, device.token, 64 * 1024)
    return { endpoint: device.endpoint, info }
  }

  onProgress?.({
    progress: 0.45,
    title: '正在测试速度',
    detail: matches.length > 1 ? `正在比较 ${matches.length} 条连接线路...` : '正在测试当前连接吞吐...'
  })
  const measured = await Promise.all(matches.map(async (match) => {
    try {
      const speed = await measureDownloadSpeed(match.endpoint, device.token)
      return { ...match, speedMbps: speed.mbps, authFailed: false, authError: null }
    } catch (error) {
      return {
        ...match,
        speedMbps: 0,
        authFailed: isAuthError(error),
        authError: error instanceof ApiError ? error : null
      }
    }
  }))

  if (measured.length > 0 && measured.every(item => item.authFailed)) {
    const authError = measured.find(item => item.authError)?.authError
    throw new ApiError(
      authError ? authErrorMessage(authError) : '这台电脑已取消当前手机的授权，请重新扫码绑定。',
      authError?.status || 401,
      authError?.code || 'unauthorized'
    )
  }

  const selected = measured.sort((a, b) => {
    const speedDiff = (b.speedMbps || 0) - (a.speedMbps || 0)
    if (Math.abs(speedDiff) > 1) return speedDiff
    return (a.info.latencyMs || Infinity) - (b.info.latencyMs || Infinity)
  })[0]
  onProgress?.({
    progress: 0.64,
    title: '正在稳定连接',
    detail: `已选择 ${selected.endpoint.replace(/^https?:\/\//, '')}`
  })
  return selected
}

export async function checkDeviceAvailability(device: StoredDevice): Promise<DeviceAvailability> {
  const candidates = uniqueEndpoints(device.endpoint, device.endpoints)
  const attempts = await Promise.all(candidates.map(async (endpoint) => {
    try {
      const info = await getInfo(endpoint)
      if (device.id && info.deviceId && info.deviceId !== device.id) {
        return { state: 'mismatch' as const, endpoint }
      }
      await measureDownloadSpeed(endpoint, device.token, 64 * 1024)
      await saveDevice({
        ...device,
        id: info.deviceId || device.id,
        name: info.deviceName || device.name,
        endpoint,
        endpoints: uniqueEndpoints(endpoint, info.endpoint, info.endpoints, device.endpoints),
        lastConnectedAt: Date.now()
      })
      return { state: 'online' as const, endpoint }
    } catch (error) {
      if (isAuthError(error)) {
        return { state: 'unauthorized' as const, endpoint }
      }
      return { state: 'offline' as const, endpoint }
    }
  }))

  if (attempts.some(item => item.state === 'online')) {
    const online = attempts.find(item => item.state === 'online')
    return { state: 'online', text: '在线', endpoint: online?.endpoint }
  }
  if (attempts.some(item => item.state === 'unauthorized')) {
    return { state: 'unauthorized', text: '授权已失效' }
  }
  if (attempts.some(item => item.state === 'mismatch')) {
    return { state: 'mismatch', text: '地址属于另一台电脑' }
  }
  return { state: 'offline', text: '离线' }
}

export async function testConnection(device: StoredDevice, onProgress?: ProgressCallback) {
  const { endpoint, info } = await findBestEndpoint(device, onProgress)
  const nextDevice = {
    ...device,
    id: info.deviceId || device.id,
    name: info.deviceName || device.name,
    endpoint,
    endpoints: uniqueEndpoints(endpoint, info.endpoint, info.endpoints, device.endpoints),
    lastConnectedAt: Date.now()
  }
  await saveDevice(nextDevice)
  onProgress?.({
    progress: 0.7,
    title: '连接已建立',
    detail: '正在保存本次最快线路...'
  })
  return nextDevice
}
