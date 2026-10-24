import type { StoredDevice, VideoItem } from '../types'
import { publishDeviceFocus, releaseDeviceFocus } from './active-device-context'

type DeviceRoute = { deviceId: string, bindingId?: string }
export type AppRoute = { key: string } & (
  | { name: 'loading' | 'pair' | 'devices' }
  | ({ name: 'library' } & DeviceRoute)
  | ({ name: 'search', queueId: string } & DeviceRoute)
  | ({ name: 'player', queueId: string, videoId: string } & DeviceRoute)
)
// Screen inputs are consumed immediately; credentials and media objects never enter the route stack.
export type NavigationTarget =
  | { name: 'loading' | 'pair' | 'devices' }
  | { name: 'library', device: StoredDevice }
  | { name: 'search', device: StoredDevice, videos: VideoItem[] }
  | { name: 'player', device: StoredDevice, video: VideoItem, videos: VideoItem[] }

const deviceKey = (device: { id: string, bindingId?: string }) => JSON.stringify([device.id, device.bindingId || ''])
type Queue = { deviceKey: string, ids: string[], resolved?: VideoItem[] }

export class NavigationStore {
  private focusOwner = Symbol('navigation')
  private sequence = 0
  private stack: readonly AppRoute[] = [{ key: 'boot', name: 'loading' }]
  private devices: StoredDevice[] = []
  private retired = new Set<string>()
  private media = new Map<string, Map<string, VideoItem>>()
  private queues = new Map<string, Queue>()
  private listeners = new Set<() => void>()
  getSnapshot = () => this.stack
  subscribe = (listener: () => void) => {
    this.listeners.add(listener); this.publishFocus()
    return () => { this.listeners.delete(listener); if (!this.listeners.size) releaseDeviceFocus(this.focusOwner) }
  }
  getDevices = () => this.devices
  getDevice(route: AppRoute): StoredDevice | undefined {
    if (!('deviceId' in route)) return undefined
    return this.devices.find(device => device.id === route.deviceId && device.bindingId === route.bindingId)
  }
  getPlaylist(route: AppRoute): VideoItem[] {
    if (!('queueId' in route)) return []
    const queue = this.queues.get(route.queueId)
    if (!queue) return []
    if (!queue.resolved) {
      const index = this.media.get(queue.deviceKey)
      queue.resolved = queue.ids.map(id => index?.get(id)).filter((item): item is VideoItem => Boolean(item))
    }
    return queue.resolved
  }
  updateVideo(deviceId: string, bindingId: string | undefined, videoId: string, patch: Partial<VideoItem>) {
    const device = this.devices.find(item => item.id === deviceId && item.bindingId === bindingId)
    if (!device) return
    const identity = deviceKey(device), index = this.media.get(identity), video = index?.get(videoId)
    if (!video) return
    index!.set(videoId, { ...video, ...patch })
    for (const queue of this.queues.values()) if (queue.deviceKey === identity) queue.resolved = undefined
    this.stack = [...this.stack]; this.publish()
  }
  setDevices(devices: StoredDevice[]) {
    for (const previous of this.devices) {
      if (!devices.some(device => deviceKey(device) === deviceKey(previous))) this.retired.add(deviceKey(previous))
    }
    this.devices = devices
    const invalid = this.stack.findIndex(route => 'deviceId' in route && !this.getDevice(route))
    if (invalid >= 0) this.stack = this.stack.slice(0, invalid)
    if (!this.stack.length) this.stack = [this.route({ name: devices.length ? 'devices' : 'pair' })!]
    this.publish()
  }
  invalidateDevice(deviceId: string, bindingId?: string) {
    const removed = this.devices.filter(device => device.id === deviceId && (!bindingId || device.bindingId === bindingId))
    removed.forEach(device => this.retired.add(deviceKey(device)))
    if (bindingId) this.retired.add(deviceKey({ id: deviceId, bindingId }))
    this.setDevices(this.devices.filter(device => !removed.includes(device)))
  }
  reset(target: NavigationTarget) {
    const route = this.route(target)
    if (route) { this.stack = [route]; this.publish() }
  }
  navigate = (target: NavigationTarget) => {
    // Returning to an existing library preserves its component, query and scroll position.
    if (target.name === 'library') {
      const existing = this.stack.findIndex(route => route.name === 'library' &&
        route.deviceId === target.device.id && route.bindingId === target.device.bindingId)
      if (existing >= 0) { this.stack = this.stack.slice(0, existing + 1); this.publish(); return }
    }
    const route = this.route(target)
    if (!route) return
    const top = this.stack[this.stack.length - 1]
    this.stack = top.name === 'loading' || (top.name === 'player' && route.name === 'player')
      ? [...this.stack.slice(0, -1), route] : [...this.stack, route]
    this.publish()
  }
  replace = (target: NavigationTarget) => {
    const route = this.route(target)
    if (route) { this.stack = [...this.stack.slice(0, -1), route]; this.publish() }
  }
  back = () => {
    if (this.stack.length < 2) return false
    this.stack = this.stack.slice(0, -1); this.publish(); return true
  }
  private route(target: NavigationTarget): AppRoute | null {
    const key = `route_${++this.sequence}`
    if (!('device' in target)) return { key, name: target.name }
    const identity = deviceKey(target.device)
    if (this.retired.has(identity)) return null
    this.devices = [target.device, ...this.devices.filter(device => device.id !== target.device.id)]
    const device = { deviceId: target.device.id, bindingId: target.device.bindingId }
    if (target.name === 'library') return { key, name: target.name, ...device }
    let index = this.media.get(identity)
    if (!index) { index = new Map(); this.media.set(identity, index) }
    const items = target.name === 'player' ? [...target.videos, target.video] : target.videos
    const ids = [...new Set(items.map(item => item.id))]
    // Preserve the input playlist order; the selected video is inserted only when absent.
    if (target.name === 'player') {
      const ordered = [...new Set(target.videos.map(item => item.id))]
      if (!ordered.includes(target.video.id)) ordered.unshift(target.video.id)
      ids.splice(0, ids.length, ...ordered)
    }
    items.forEach(item => index!.set(item.id, item))
    for (const queue of this.queues.values()) if (queue.deviceKey === identity) queue.resolved = undefined
    const queueId = `queue_${this.sequence}`
    this.queues.set(queueId, { deviceKey: identity, ids })
    return target.name === 'player'
      ? { key, name: 'player', ...device, queueId, videoId: target.video.id }
      : { key, name: 'search', ...device, queueId }
  }
  private publish() {
    const retained = new Set(this.stack.flatMap(route => 'queueId' in route ? [route.queueId] : []))
    for (const id of this.queues.keys()) if (!retained.has(id)) this.queues.delete(id)
    for (const [identity, index] of this.media) {
      const ids = new Set([...this.queues.values()].filter(queue => queue.deviceKey === identity).flatMap(queue => queue.ids))
      for (const id of index.keys()) if (!ids.has(id)) index.delete(id)
      if (!index.size) this.media.delete(identity)
    }
    this.publishFocus()
    this.listeners.forEach(listener => listener())
  }
  private publishFocus() {
    if (!this.listeners.size) return
    const route = this.stack[this.stack.length - 1]
    publishDeviceFocus(this.focusOwner, 'deviceId' in route ? { deviceId: route.deviceId, bindingId: route.bindingId } : null)
  }
  diagnostics() { return { routes: this.stack.length, queues: this.queues.size,
    media: [...this.media.values()].reduce((count, index) => count + index.size, 0), listeners: this.listeners.size } }
}
