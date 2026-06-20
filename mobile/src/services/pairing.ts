import { claimPairing, getInfo } from './api'
import type { PairingPayload, StoredDevice } from '../types'
import { getClientId } from '../stores/devices'
import { normalizeEndpoint } from '../utils/url'

const PAIRING_POLL_INTERVAL_MS = 1200
const PAIRING_WAIT_TIMEOUT_MS = 2 * 60 * 1000

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

export function parsePairingCode(raw: string): PairingPayload | null {
  const value = raw.trim()
  if (!value) return null

  try {
    if (value.startsWith('wallpaper-player://pair?')) {
      const query = value.split('?')[1] || ''
      const params = new URLSearchParams(query)
      const data = params.get('data')
      if (!data) return null
      return JSON.parse(decodeBase64Url(data)) as PairingPayload
    }

    if (value.startsWith('{')) {
      return JSON.parse(value) as PairingPayload
    }
  } catch {
    return null
  }

  return null
}

export async function createManualDevice(endpointInput: string, token: string): Promise<StoredDevice> {
  const endpoint = normalizeEndpoint(endpointInput)
  if (!endpoint) throw new Error('请输入电脑访问地址')
  if (!token.trim()) throw new Error('请输入访问 token')

  const info = await getInfo(endpoint)
  return {
    id: info.deviceId || endpoint,
    name: info.deviceName || 'Wallpaper Player',
    endpoint: info.endpoint ? normalizeEndpoint(info.endpoint) : endpoint,
    endpoints: uniqueEndpoints(info.endpoint, info.endpoints, endpoint),
    token: token.trim(),
    lastConnectedAt: Date.now()
  }
}

export async function createDeviceFromPairingPayload(payload: PairingPayload, fallbackToken = ''): Promise<StoredDevice> {
  if (!payload.endpoint) throw new Error('二维码缺少电脑地址')
  if (payload.expiresAt && payload.expiresAt < Date.now()) throw new Error('二维码已过期')

  const endpoint = normalizeEndpoint(payload.endpoint)
  if (!endpoint) throw new Error('二维码里的电脑地址无效')

  if (payload.pairingId && payload.oneTimeSecret && !payload.token) {
    const waitDeadline = Math.min(
      payload.expiresAt || Date.now() + PAIRING_WAIT_TIMEOUT_MS,
      Date.now() + PAIRING_WAIT_TIMEOUT_MS
    )
    const client = {
      clientId: await getClientId(),
      clientName: 'Wallpaper Player Mobile'
    }
    let claimed = await claimPairing(endpoint, payload, client)
    while (claimed.status === 'pending') {
      if (Date.now() >= waitDeadline) {
        throw new Error('等待电脑端允许绑定超时，请在电脑端重新生成绑定码')
      }
      await delay(PAIRING_POLL_INTERVAL_MS)
      claimed = await claimPairing(endpoint, payload, client)
    }
    if (!claimed.token) {
      throw new Error('电脑端尚未允许本次绑定')
    }
    const claimedEndpoint = claimed.endpoint ? normalizeEndpoint(claimed.endpoint) : endpoint
    return {
      id: claimed.deviceId || payload.deviceId || claimedEndpoint,
      name: claimed.deviceName || payload.deviceName || 'Wallpaper Player',
      endpoint: claimedEndpoint,
      endpoints: uniqueEndpoints(claimedEndpoint, claimed.endpoints, payload.endpoints, endpoint),
      token: claimed.token,
      pairedDeviceId: claimed.pairedDeviceId,
      lastConnectedAt: Date.now()
    }
  }

  const token = payload.token || fallbackToken.trim()
  if (!token) {
    throw new Error('当前二维码不是有效的一次性绑定码，请在电脑端重新生成')
  }

  return {
    id: payload.deviceId || endpoint,
    name: payload.deviceName || 'Wallpaper Player',
    endpoint,
    endpoints: uniqueEndpoints(endpoint, payload.endpoints),
    token,
    lastConnectedAt: Date.now()
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function decodeBase64Url(input: string) {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = globalThis.atob(padded)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  let encoded = ''
  for (const byte of bytes) {
    encoded += `%${byte.toString(16).padStart(2, '0')}`
  }
  return decodeURIComponent(encoded)
}
