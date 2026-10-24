import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { ApiError, getPlaybackState, savePlaybackState } from '../services/api'
import type { PlaybackState, PlaybackWrite, StoredDevice } from '../types'
import { runWithCurrentDevice } from './devices'

const keyForPlayback = (deviceId: string, videoId: string) => `wallpaper-player.playback.${deviceId}.${videoId}`
const SESSION_COUNTER_KEY = 'wallpaper-player.playback-session.v1'
type PendingPlayback = PlaybackWrite & { position: number, updatedAt: number }
type LocalPlayback = PlaybackState & { bindingId?: string, pending?: PendingPlayback, conflict?: PlaybackState,
  checkpoint?: { session: number, sequence: number }, syncError?: { code: string, message: string } }
export type PlaybackSyncStatus = { state: 'synced' | 'pending' | 'conflict' | 'removed', message: string }
export type PlaybackSession = {
  device: StoredDevice
  videoId: string
  session: number
  sequence: number
  baseRevision: number
  position: number
  closed: boolean
  notify: (status: PlaybackSyncStatus) => void
}
const activeSyncs = new Map<string, Promise<PlaybackSyncStatus>>()
let counterChain: Promise<unknown> = Promise.resolve()
const synced: PlaybackSyncStatus = { state: 'synced', message: '' }
const removed: PlaybackSyncStatus = { state: 'removed', message: '设备已移除或重新绑定' }
const pendingStatus: PlaybackSyncStatus = { state: 'pending', message: '进度已保存在手机，等待同步' }
const conflictStatus: PlaybackSyncStatus = { state: 'conflict', message: '其他设备已更新进度；本地待同步进度已保留，继续播放会记录新进度' }

async function nextSession(floor: number) {
  const operation = counterChain.then(async () => {
    const raw = await SecureStore.getItemAsync(SESSION_COUNTER_KEY)
    const previous = raw == null ? 0 : Number(raw)
    if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('播放会话记录损坏，请重试')
    const next = Math.max(previous, floor) + 1
    if (!Number.isSafeInteger(next)) throw new Error('播放会话记录超出范围')
    await SecureStore.setItemAsync(SESSION_COUNTER_KEY, String(next))
    return next
  })
  counterChain = operation.catch(() => {})
  return operation
}
async function readRecord(device: StoredDevice, videoId: string): Promise<LocalPlayback | null> {
  return runWithCurrentDevice(device, async () => {
    const raw = await AsyncStorage.getItem(keyForPlayback(device.id, videoId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as LocalPlayback
    if (!Number.isFinite(parsed.position) || parsed.position < 0) throw new Error('本地播放进度损坏')
    if (parsed.bindingId && parsed.bindingId !== device.bindingId) return null
    return parsed
  })
}
function samePending(a: PendingPlayback | undefined, b: PendingPlayback) {
  return a?.session === b.session && a?.sequence === b.sequence
}

// Position is an intent, so a newer rewind or explicit zero takes precedence over a larger old position.
export function choosePlayback(local: PlaybackState | null, remote: PlaybackState | null): PlaybackState | null {
  if (!local) return remote
  if (!remote) return local
  if (local.revision != null && remote.revision != null && local.revision !== remote.revision) {
    return local.revision > remote.revision ? local : remote
  }
  return (local.updatedAt || 0) > (remote.updatedAt || 0) ? local : remote
}

export function syncPendingPlayback(device: StoredDevice, videoId: string): Promise<PlaybackSyncStatus> {
  const key = `${device.id}:${device.bindingId}:${videoId}`
  const running = activeSyncs.get(key)
  if (running) return running
  const operation = (async (): Promise<PlaybackSyncStatus> => {
    while (true) {
      const local = await readRecord(device, videoId)
      if (!local) return synced
      if (local.syncError) return { state: 'pending', message: local.syncError.message }
      if (local.conflict) return conflictStatus
      const pending = local.pending
      if (!pending) return synced
      let remote: PlaybackState
      try {
        const response = await savePlaybackState(device, videoId, pending.position, pending)
        if (!response.success) throw new Error('电脑未确认保存播放进度')
        remote = response.playback || { position: pending.position, updatedAt: pending.updatedAt }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'playback_conflict') {
          let latest: PlaybackState | null
          try { latest = await getPlaybackState(device, videoId) } catch { return pendingStatus }
          if (!latest) return pendingStatus
          const saved = await runWithCurrentDevice(device, async () => {
            const raw = await AsyncStorage.getItem(keyForPlayback(device.id, videoId))
            if (!raw) return false
            const current = JSON.parse(raw) as LocalPlayback
            if (samePending(current.pending, pending)) {
              await AsyncStorage.setItem(keyForPlayback(device.id, videoId), JSON.stringify({ ...current, conflict: latest }))
              return true
            }
            // A newer local intent still uses the stale base and must be explicitly reconciled.
            if (current.pending && current.pending.baseRevision === pending.baseRevision) {
              await AsyncStorage.setItem(keyForPlayback(device.id, videoId), JSON.stringify({ ...current, conflict: latest }))
            }
            return true
          })
          return saved == null ? removed : conflictStatus
        }
        const message = error instanceof ApiError && (error.status === 401 || error.status === 403)
          ? '进度已保存在手机，电脑授权失效，请重新绑定' : error instanceof ApiError && !error.retryable
            ? '进度已保存在手机：' + error.message : pendingStatus.message
        if (error instanceof ApiError && !error.retryable) {
          await runWithCurrentDevice(device, async () => {
            const raw = await AsyncStorage.getItem(keyForPlayback(device.id, videoId))
            if (!raw) return
            const current = JSON.parse(raw) as LocalPlayback
            if (current.pending && current.pending.baseRevision === pending.baseRevision) {
              await AsyncStorage.setItem(keyForPlayback(device.id, videoId), JSON.stringify({ ...current,
                syncError: { code: error.code || 'operation_failed', message } }))
            }
          })
        }
        return { ...pendingStatus, message }
      }
      const committed = await runWithCurrentDevice(device, async () => {
        const raw = await AsyncStorage.getItem(keyForPlayback(device.id, videoId))
        if (!raw) return false
        const current = JSON.parse(raw) as LocalPlayback
        if (samePending(current.pending, pending)) {
          await AsyncStorage.setItem(keyForPlayback(device.id, videoId), JSON.stringify({ ...remote, bindingId: device.bindingId,
            checkpoint: { session: pending.session, sequence: pending.sequence } }))
        } else if (current.pending) {
          // Acknowledge only the sent checkpoint and rebase its newer local successor.
          const nextPending = { ...current.pending }
          if (nextPending.baseRevision === pending.baseRevision) nextPending.baseRevision = remote.revision || 0
          await AsyncStorage.setItem(keyForPlayback(device.id, videoId), JSON.stringify({ ...current,
            revision: remote.revision, pending: nextPending }))
        }
        return true
      })
      if (committed == null) return removed
    }
  })()
  activeSyncs.set(key, operation)
  void operation.finally(() => {
    if (activeSyncs.get(key) === operation) activeSyncs.delete(key)
  }).catch(() => {})
  return operation
}

export async function openPlaybackSession(device: StoredDevice, videoId: string,
  notify: (status: PlaybackSyncStatus) => void = () => {}): Promise<PlaybackSession> {
  const syncStatus = await syncPendingPlayback(device, videoId)
  const [local, remote] = await Promise.all([
    readRecord(device, videoId), getPlaybackState(device, videoId).catch(() => null)
  ])
  const desired = local?.conflict ? remote || local.conflict : local?.pending ? local : choosePlayback(local, remote)
  const session = await nextSession(Math.max(remote?.writer?.session || 0, local?.pending?.session || 0, local?.checkpoint?.session || 0))
  const result: PlaybackSession = { device, videoId, session, sequence: 0,
    baseRevision: remote?.revision ?? local?.conflict?.revision ?? local?.pending?.baseRevision ?? local?.revision ?? 0,
    position: desired?.position ?? 0, closed: false, notify }
  notify(syncStatus)
  return result
}

export async function recordPlayback(session: PlaybackSession, position: number, explicitIntent = false) {
  if (session.closed) return
  if (!Number.isFinite(position) || position < 0) throw new Error('播放位置无效')
  const sequence = ++session.sequence
  const { device, videoId } = session
  const pending: PendingPlayback = { position, updatedAt: Date.now(), session: session.session, sequence,
    baseRevision: session.baseRevision }
  const saved = await runWithCurrentDevice(device, async () => {
    const raw = await AsyncStorage.getItem(keyForPlayback(device.id, videoId))
    const current = raw ? JSON.parse(raw) as LocalPlayback : null
    const owner = current?.checkpoint || current?.pending
    if (owner && (owner.session > pending.session || (owner.session === pending.session && owner.sequence >= sequence))) return false
    if (current?.syncError && !explicitIntent && current.pending?.session === session.session) return false
    if (current?.conflict && !explicitIntent && current.pending?.session === session.session) return false
    if (current?.conflict && explicitIntent) pending.baseRevision = current.conflict.revision || 0
    if (current?.pending && (current.pending.session > pending.session ||
      (current.pending.session === pending.session && current.pending.sequence > sequence))) return false
    // A completed acknowledgement may advance the revision while this checkpoint is queued.
    pending.baseRevision = Math.max(pending.baseRevision, current?.revision || 0)
    await AsyncStorage.setItem(keyForPlayback(device.id, videoId), JSON.stringify({
      position, updatedAt: pending.updatedAt, revision: current?.revision || session.baseRevision,
      bindingId: device.bindingId, pending, checkpoint: { session: pending.session, sequence }
    }))
    return true
  })
  if (saved == null) { session.notify(removed); return }
  if (!saved) return
  session.position = position
  session.notify(pendingStatus)
  void syncPendingPlayback(device, videoId).then(async status => {
    const current = await readRecord(device, videoId)
    if (current && !current.pending) session.baseRevision = current.revision || session.baseRevision
    session.notify(status)
  }).catch(error => session.notify({ ...pendingStatus, message: error instanceof Error ? error.message : '进度同步失败，请重试' }))
}

export function closePlaybackSession(session: PlaybackSession) { session.closed = true }
