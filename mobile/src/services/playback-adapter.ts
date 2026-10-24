import type { VideoPlayer, VideoSource } from 'expo-video'

export type PlaybackOwner = { player: VideoPlayer, videoId: string, source: string, deviceId: string,
  bindingId?: string, token: string }
export type MobilePlayerState = { phase: 'idle' | 'loading' | 'ready' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error' | 'stopped',
  position: number, duration: number, paused: boolean, speed: number, error: string }
type Source = Exclude<VideoSource, number | string | null>

function sameSource(value: VideoSource | null | undefined, expected: Source) {
  if (typeof value === 'string') return value === expected.uri && !expected.headers?.Authorization
  if (!value || typeof value !== 'object') return false
  const authorization = Object.entries(value.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
  return value.uri === expected.uri && authorization === expected.headers?.Authorization
}

/** Owns source changes and controls on the one SDK-owned native instance. */
export class ExpoPlaybackAdapter {
  readonly engine = 'expo' as const
  private owner: PlaybackOwner | null = null
  private source: Source | null = null
  private pending: { owner: PlaybackOwner, source: Source, autoplay: () => boolean } | null = null
  private flight: Promise<void> | null = null
  private clearFlight: Promise<void> = Promise.resolve()
  private committed = false
  private metadata = false
  private loaded = false
  private desiredPlaying = true
  private explicitPosition: number | null = null
  private lastPosition = 0
  private lastDuration = 0
  private lastSpeed = 1
  private phase: MobilePlayerState['phase'] = 'idle'
  private error = ''
  private failed: ((error: unknown) => void) | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  constructor(readonly player: VideoPlayer, private deadlineMs = 25000) {}
  owns(owner: PlaybackOwner) { return this.owner === owner && this.phase !== 'stopped' }
  load(owner: PlaybackOwner, autoplay: () => boolean, failed: (error: unknown) => void) {
    if (owner.player !== this.player) throw new TypeError('播放会话与原生实例不匹配')
    this.owner = owner; this.source = { uri: owner.source, headers: { Authorization: `Bearer ${owner.token}` } }
    this.committed = false; this.metadata = false; this.loaded = false; this.explicitPosition = null
    this.lastPosition = 0; this.lastDuration = 0; this.failed = failed
    this.desiredPlaying = true; this.phase = 'loading'; this.error = ''
    try { this.player.pause() } catch (error) { this.fail(owner, error); return }
    this.pending = { owner, source: this.source, autoplay }
    this.clearDeadline()
    this.deadline = setTimeout(() => {
      if (!this.owns(owner) || this.ready(owner)) return
      this.fail(owner, new Error('媒体加载超时，请重试'))
    }, this.deadlineMs)
    if (this.flight) {
      // SDK null replacement cancels iOS asset loading; the queued latest source waits for its completion.
      this.clearNativeSource()
    } else this.drain()
  }
  private clearDeadline() {
    if (this.deadline !== null) clearTimeout(this.deadline)
    this.deadline = null
  }
  private clearNativeSource() {
    try {
      this.player.pause()
      const clear = this.player.replaceAsync(null).catch(() => {})
      this.clearFlight = Promise.all([this.clearFlight, clear]).then(() => {})
    } catch {}
  }
  private fail(owner: PlaybackOwner, error: unknown) {
    if (!this.owns(owner)) return
    const failed = this.failed
    this.owner = null; this.pending = null; this.failed = null
    this.phase = 'error'; this.error = error instanceof Error ? error.message : '媒体加载失败'
    this.clearDeadline(); this.clearNativeSource()
    failed?.(error)
  }
  private drain() {
    const request = this.pending
    if (!request) return
    this.pending = null
    const flight = Promise.resolve().then(async () => {
      await this.clearFlight
      if (!this.owns(request.owner)) return
      await this.player.replaceAsync(request.source)
      if (!this.owns(request.owner)) return
      if (this.ready(request.owner)) this.applyIntent(request.autoplay)
    }).catch(error => this.fail(request.owner, error)).finally(() => {
      if (this.flight === flight) this.flight = null
      this.drain()
    })
    this.flight = flight
  }
  sourceChanged(owner: PlaybackOwner, source: VideoSource) {
    if (!this.owns(owner) || !this.source || !sameSource(source, this.source)) return false
    this.committed = true; return true
  }
  sourceLoaded(owner: PlaybackOwner, source: VideoSource | null, autoplay: () => boolean) {
    if (!this.owns(owner) || !this.source || !sameSource(source, this.source)) return false
    this.committed = true; this.metadata = true
    if (this.ready(owner)) {
      try { this.applyIntent(autoplay) } catch (error) { this.fail(owner, error); return false }
    }
    return true
  }
  ready(owner: PlaybackOwner) {
    try { return this.owns(owner) && this.committed && this.metadata && this.player.status === 'readyToPlay' } catch { return false }
  }
  acceptsStatus(owner: PlaybackOwner, status: VideoPlayer['status']) {
    try { if (!this.owns(owner) || status !== this.player.status) return false } catch { return false }
    if (status === 'readyToPlay') return this.ready(owner)
    return status === 'loading' || this.committed
  }
  statusChanged(owner: PlaybackOwner, status: VideoPlayer['status'], message?: string) {
    if (!this.acceptsStatus(owner, status)) return false
    if (status === 'error') this.fail(owner, new Error(message || '播放失败'))
    else if (status === 'loading') this.phase = this.loaded ? 'buffering' : 'loading'
    else if (status === 'readyToPlay' && this.phase !== 'ended') this.phase = 'ready'
    return true
  }
  acceptsTime(owner: PlaybackOwner) { return this.ready(owner) }
  private applyIntent(autoplay: () => boolean) {
    this.loaded = true; this.clearDeadline()
    if (this.explicitPosition !== null) { this.player.currentTime = this.explicitPosition; this.explicitPosition = null }
    if (this.desiredPlaying && autoplay()) this.player.play()
    else this.player.pause()
    if (this.phase !== 'ended') this.phase = this.player.playing ? 'playing' : 'paused'
  }
  activate(owner: PlaybackOwner, autoplay: () => boolean) {
    if (this.ready(owner)) {
      try { this.applyIntent(autoplay) } catch (error) { this.fail(owner, error) }
    }
  }
  play() {
    this.desiredPlaying = true
    if (this.owner && this.ready(this.owner)) { this.phase = 'playing'; this.player.play() }
  }
  pause() { this.desiredPlaying = false; this.player.pause() }
  seek(position: number) {
    this.explicitPosition = Number.isFinite(position) ? Math.max(0, position) : 0
    this.lastPosition = this.explicitPosition
    if (this.phase === 'ended') this.phase = 'paused'
    if (this.owner && this.ready(this.owner)) { this.player.currentTime = this.explicitPosition; this.explicitPosition = null }
  }
  ended(owner: PlaybackOwner) {
    if (!this.ready(owner) || !this.loaded) return false
    const state = this.getState()
    // This SDK event has no source identity; require the current item to actually be at its end.
    if (state.duration <= 0 || state.duration - state.position > Math.min(0.75, state.duration / 4)) return false
    this.desiredPlaying = false; this.phase = 'ended'; this.player.pause()
    return true
  }
  getState(): MobilePlayerState {
    const usable = Boolean(this.owner && this.loaded && this.committed && this.metadata)
    let playing = false
    try {
      if (usable) {
        const position = Number(this.player.currentTime), duration = Number(this.player.duration)
        if (Number.isFinite(position)) this.lastPosition = Math.max(0, position)
        if (Number.isFinite(duration)) this.lastDuration = Math.max(0, duration)
        playing = this.player.playing
      }
      const speed = Number(this.player.playbackRate)
      if (Number.isFinite(speed) && speed > 0) this.lastSpeed = speed
    } catch { /* SDK releases the SharedObject independently during unmount. */ }
    const phase = usable && this.phase !== 'buffering' && this.phase !== 'ended' ? playing ? 'playing' : 'paused' : this.phase
    return { phase, position: this.explicitPosition ?? this.lastPosition,
      duration: this.lastDuration, paused: !playing, speed: this.lastSpeed, error: this.error }
  }
  stop(owner?: PlaybackOwner) {
    if (owner && this.owner !== owner) return
    this.getState()
    this.owner = null; this.pending = null; this.committed = false; this.metadata = false
    this.failed = null; this.clearDeadline()
    this.phase = 'stopped'
    this.clearNativeSource()
  }
}
