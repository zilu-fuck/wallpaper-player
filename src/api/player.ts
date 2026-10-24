import { playerActionSchema, playerActionResultSchema, playerNativeStateSchema, type PlayerAction,
  type PlayerCommand, type PlayerNativeState } from '@wallpaper/contracts'
import { DesktopApiError } from './media'
import type { ElectronAPI } from '../electronAPI'

export type PlayerPhase = 'idle' | 'loading' | 'ready' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error' | 'stopped'
export type PlayerSnapshot = { phase: PlayerPhase, position: number, duration: number, paused: boolean,
  volume: number, muted: boolean, speed: number, error: string, loop?: boolean, explicitPosition?: number,
  native?: PlayerNativeState, endedReason?: string, errorCode?: string }
export type LoadInput = { target: string, source: 'local' | 'network', resume?: boolean,
  hostBounds?: { x: number, y: number, width: number, height: number }, title?: string,
  kind?: 'direct' | 'webpage', temporary?: boolean }
export interface PlaybackAdapter {
  readonly engine: 'mpv' | 'html5' | 'webpage'
  readonly sessionId: string
  play(): Promise<void>
  pause(): Promise<void>
  seek(position: number): Promise<void>
  stop(): Promise<void>
  getState(): PlayerSnapshot
  subscribe(listener: (state: PlayerSnapshot) => void): () => void
}
const sessionId = () => `player_${globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)}`
const initial = (): PlayerSnapshot => ({ phase: 'idle', position: 0, duration: 0, paused: true, volume: 100, muted: false, speed: 1, error: '' })

abstract class ObservablePlayer implements PlaybackAdapter {
  abstract readonly engine: PlaybackAdapter['engine']
  readonly sessionId = sessionId()
  protected active = true
  protected state = initial()
  private listeners = new Set<(state: PlayerSnapshot) => void>()
  getState() { return this.state }
  subscribe(listener: (state: PlayerSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  protected publish(state: PlayerSnapshot) { if (!this.active) return; this.state = state; this.listeners.forEach(listener => listener(state)) }
  protected failure(error: unknown) { this.publish({ ...this.state, phase: 'error',
    error: error instanceof Error ? error.message : '播放失败', errorCode: error instanceof DesktopApiError ? error.code : undefined }) }
  protected release() { this.active = false; this.listeners.clear(); this.state = { ...this.state, phase: 'stopped', paused: true } }
  abstract play(): Promise<void>
  abstract pause(): Promise<void>
  abstract seek(position: number): Promise<void>
  abstract stop(): Promise<void>
}

export class MpvAdapter extends ObservablePlayer {
  readonly engine = 'mpv' as const
  private removers: Array<() => void> = []
  private pendingSeek: number | null = null
  private pendingPaused: boolean | null = null
  constructor(private api: ElectronAPI = window.electronAPI) { super() }
  private accepts(value: unknown): boolean {
    return this.active && Boolean(value && typeof value === 'object' && (value as { sessionId?: string }).sessionId === this.sessionId)
  }
  private receive(value: unknown) {
    if (!this.accepts(value)) return
    try {
      const native = playerNativeStateSchema.parse(value)
      this.publish({ phase: native.eofReached ? 'ended' : !native.ready ? 'loading' : native.buffering ? 'buffering' : native.paused ? 'paused' : 'playing',
        position: native.timePos, duration: native.duration, paused: native.paused, volume: native.volume,
        muted: native.muted, speed: native.speed, error: '', native })
    } catch { this.failure(new DesktopApiError('播放器状态格式无效', 'invalid_response')) }
  }
  private async invoke(request: PlayerAction) {
    if (!this.active) return undefined
    if (!this.api?.playerAction) throw new DesktopApiError('播放器接口不可用', 'ipc_unavailable', true)
    const result = playerActionResultSchema.parse(await this.api.playerAction(playerActionSchema.parse(request)))
    if (!this.active) return undefined
    if (!result.success) throw new DesktopApiError(result.error || '播放操作失败', result.code, result.retryable)
    if (result.sessionId !== this.sessionId) throw new DesktopApiError('播放器响应会话不匹配', 'invalid_response')
    return result
  }
  async load(input: LoadInput) {
    if (!this.active) return
    if (!this.api?.playerAction) throw new DesktopApiError('播放器接口不可用', 'ipc_unavailable', true)
    this.publish({ ...initial(), phase: 'loading' })
    this.removers.push(this.api.onMpvState(value => this.receive(value)))
    this.removers.push(this.api.onMpvEnded(((value: { sessionId?: string, reason?: string }) => {
      if (this.accepts(value)) this.publish({ ...this.state, phase: 'ended', paused: true, endedReason: value.reason })
    }) as Parameters<ElectronAPI['onMpvEnded']>[0]))
    this.removers.push(this.api.onMpvError(value => {
      if (this.accepts(value)) this.failure(new Error(String((value as unknown as { message?: string }).message || 'mpv 播放出错')))
    }))
    try {
      const result = await this.invoke({ action: 'load', sessionId: this.sessionId, ...input })
      if (!result) return
      if (result.webpageUrl) return { webpageUrl: result.webpageUrl }
      if (this.pendingSeek !== null) await this.command({ command: 'seekTo', value: this.pendingSeek })
      if (this.pendingPaused !== null) await this.command({ command: 'setPaused', value: this.pendingPaused })
      this.receive((await this.invoke({ action: 'state', sessionId: this.sessionId }))?.state || result.state)
    } catch (error) { if (this.active) this.failure(error); throw error }
  }
  async command(command: PlayerCommand) {
    if (!this.active) return undefined
    const result = await this.invoke({ action: 'command', sessionId: this.sessionId, command })
    if (result?.state) this.receive(result.state)
    return result
  }
  async play() { this.pendingPaused = false; if (this.state.phase !== 'loading') await this.command({ command: 'setPaused', value: false }) }
  async pause() { this.pendingPaused = true; if (this.state.phase !== 'loading') await this.command({ command: 'setPaused', value: true }) }
  async seek(position: number) { this.pendingSeek = Math.max(0, position); if (this.state.phase !== 'loading') await this.command({ command: 'seekTo', value: this.pendingSeek }) }
  async bounds(bounds: LoadInput['hostBounds']) { if (bounds && this.state.phase !== 'loading') await this.invoke({ action: 'bounds', sessionId: this.sessionId, bounds }) }
  async stop() {
    if (!this.active) return
    const api = this.api, id = this.sessionId
    this.release(); this.removers.splice(0).forEach(remove => remove())
    if (api?.playerAction) {
      const result = playerActionResultSchema.parse(await api.playerAction({ action: 'stop', sessionId: id }))
      if (!result.success && result.code !== 'stale_session') throw new DesktopApiError(result.error, result.code)
    }
  }
}

type MediaElement = Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'paused' | 'volume' | 'muted' | 'playbackRate' |
  'loop' | 'src' | 'readyState' | 'error' | 'play' | 'pause' | 'load' | 'removeAttribute' | 'addEventListener' | 'removeEventListener'>
export class Html5Adapter extends ObservablePlayer {
  readonly engine = 'html5' as const
  private element: MediaElement | null = null
  private removers: Array<() => void> = []
  private source = ''
  private restore: Partial<Pick<PlayerSnapshot, 'position' | 'volume' | 'muted' | 'speed' | 'loop'>> = {}
  private explicitSeek: number | null = null
  private pendingPaused: boolean | null = null
  load(source: string, restore: typeof this.restore = {}) {
    if (!this.active) return
    this.source = source; this.restore = restore; this.publish({ ...initial(), phase: 'loading',
      position: this.explicitSeek ?? 0, explicitPosition: this.explicitSeek ?? undefined })
    if (this.element) this.attach(this.element)
  }
  attach(element: MediaElement | null) {
    if (!this.active || element === this.element) return
    this.removers.splice(0).forEach(remove => remove())
    this.element = element
    if (!this.active || !element) return
    const owned = () => this.active && this.element === element
    const snapshot = () => {
      if (!owned()) return
      const duration = Number.isFinite(element.duration) ? element.duration : 0
      this.publish({ phase: element.error ? 'error' : element.readyState < 1 ? 'loading' : element.paused ? 'paused' : 'playing',
        position: Math.max(0, element.currentTime || 0), duration, paused: element.paused,
        volume: element.volume * 100, muted: element.muted, speed: element.playbackRate, loop: element.loop,
        explicitPosition: this.explicitSeek ?? undefined, error: element.error?.message || '' })
    }
    const metadata = () => {
      if (!owned()) return
      try { element.currentTime = this.explicitSeek ?? this.restore.position ?? 0 } catch {}
      if (this.pendingPaused === true) element.pause()
      else if (this.pendingPaused === false) void element.play().catch(error => { if (owned()) this.failure(error) })
      snapshot()
    }
    for (const name of ['timeupdate', 'durationchange', 'play', 'pause', 'volumechange', 'ratechange', 'error', 'playing']) {
      element.addEventListener(name, snapshot); this.removers.push(() => element.removeEventListener(name, snapshot))
    }
    const ended = () => { if (owned()) this.publish({ ...this.state, phase: 'ended', paused: true, endedReason: 'eof' }) }
    const waiting = () => { if (owned()) this.publish({ ...this.state, phase: 'buffering' }) }
    element.addEventListener('waiting', waiting); this.removers.push(() => element.removeEventListener('waiting', waiting))
    element.addEventListener('loadedmetadata', metadata); element.addEventListener('ended', ended)
    this.removers.push(() => element.removeEventListener('loadedmetadata', metadata), () => element.removeEventListener('ended', ended))
    if (this.restore.volume !== undefined) element.volume = Math.max(0, Math.min(1, this.restore.volume / 100))
    if (this.restore.muted !== undefined) element.muted = this.restore.muted
    if (this.restore.speed !== undefined) element.playbackRate = this.restore.speed
    if (this.restore.loop !== undefined) element.loop = this.restore.loop
    if (this.source && element.src !== this.source) element.src = this.source
    if (element.readyState >= 1) metadata()
  }
  async play() { if (!this.active) return; this.pendingPaused = false; await this.element?.play() }
  async pause() { if (!this.active) return; this.pendingPaused = true; this.element?.pause() }
  async seek(position: number) {
    if (!this.active) return
    this.explicitSeek = Math.max(0, position)
    this.publish({ ...this.state, position: this.explicitSeek, explicitPosition: this.explicitSeek })
    if (this.element?.readyState) this.element.currentTime = this.explicitSeek
  }
  async stop() {
    if (!this.active) return
    const element = this.element
    this.release(); this.removers.splice(0).forEach(remove => remove()); this.element = null
    if (element) { element.pause(); element.removeAttribute('src'); element.load() }
  }
}

export class WebpageAdapter extends ObservablePlayer {
  readonly engine = 'webpage' as const
  private frame: { stop?: () => void, src?: string, isLoading?: () => boolean,
    addEventListener?: (event: string, listener: () => void) => void, removeEventListener?: (event: string, listener: () => void) => void } | null = null
  private removers: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  load(frame: NonNullable<typeof this.frame>, source: string) {
    if (!this.active || this.frame === frame) return
    this.frame = frame; if (frame.src !== source) frame.src = source
    this.publish({ ...initial(), phase: 'loading' })
    const loaded = () => { if (this.active && this.frame === frame) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.publish({ ...initial(), phase: 'ready' }) } }
    const failed = () => { if (this.active && this.frame === frame) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.failure(new Error('网页加载失败')) } }
    frame.addEventListener?.('did-finish-load', loaded); frame.addEventListener?.('did-fail-load', failed)
    this.removers.push(() => frame.removeEventListener?.('did-finish-load', loaded), () => frame.removeEventListener?.('did-fail-load', failed))
    this.timer = setTimeout(failed, 30000)
    try { if (frame.isLoading?.() === false) loaded() } catch {}
  }
  async play() { throw new DesktopApiError('网页播放器由网页控制', 'unsupported_operation') }
  async pause() { throw new DesktopApiError('网页播放器由网页控制', 'unsupported_operation') }
  async seek() { throw new DesktopApiError('网页播放器由网页控制', 'unsupported_operation') }
  async stop() {
    const frame = this.frame; this.release(); this.frame = null
    if (this.timer) clearTimeout(this.timer); this.timer = null
    this.removers.splice(0).forEach(remove => remove())
    try { frame?.stop?.() } finally { if (frame) frame.src = 'about:blank' }
  }
}
