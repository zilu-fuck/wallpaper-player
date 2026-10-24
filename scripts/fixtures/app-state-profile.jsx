import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App'
import '../../src/index.css'

const listeners = new Map(), errors = [], profiles = [], renders = [], actions = []
const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn) }
const emit = (name, value) => [...(listeners.get(name) || [])].forEach(fn => fn(value))
const clone = value => JSON.parse(JSON.stringify(value))
const directory = 'C:\\profile-fixture'
const videos = Array.from({ length: 10000 }, (_, index) => ({
  fullPath: directory + '\\video-' + String(index).padStart(5, '0') + '.mp4',
  favoriteKey: directory + '\\video-' + String(index).padStart(5, '0') + '.mp4',
  name: '视频 ' + String(index).padStart(5, '0'), fileName: 'video-' + index + '.mp4',
  extension: '.mp4', size: 1000 + index, tags: ['测试'], media: { available: true, durationSeconds: 120 }
}))
let settings = { theme: 'dark', directories: [directory], privateDirectories: [], defaultDirectory: directory,
  favorites: [], customTags: {}, hiddenTags: [], networkResources: [], playbackStates: {}, playbackMode: 'order',
  privacy: { passwordSet: false }, videoAnalysis: { enabled: true } }
const plugins = [{ id: 'video-analysis', enabled: true, name: '视频理解' }, { id: 'ai-search', enabled: false }]
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="#446"/></svg>')
let nativeState = null, engine = 0
window.__auditRender = (name, target) => renders.push({ name, target })
window.__auditOnRender = (id, phase, actualDuration, baseDuration, startTime, commitTime) => profiles.push({ id, phase, actualDuration, baseDuration, startTime, commitTime })
window.addEventListener('error', event => errors.push(String(event.error?.stack || event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack || event.reason)))
window.electronAPI = {
  getSettings: async () => clone(settings), onSettingsChanged: fn => on('settings', fn),
  saveSettings: async patch => { settings = { ...settings, ...patch }; emit('settings', clone(settings)); return { success: true, settings: clone(settings) } },
  setVideoFavorite: async (video, favorite) => {
    const key = video.favoriteKey || video.fullPath
    actions.push({ key, favorite })
    settings = { ...settings, favorites: favorite ? [...new Set([...settings.favorites, key])] : settings.favorites.filter(value => value !== key) }
    emit('settings', clone(settings))
    return { success: true, favorite, favoriteKey: key, settings: clone(settings) }
  },
  listPlugins: async () => clone(plugins), scanDirectory: async () => ({ videos, refreshing: false, indexed: true }),
  checkFfmpeg: async () => ({ available: true }), checkMpv: async () => ({ available: true }), getAppVersion: async () => 'profile-fixture',
  onPrivacyStateChanged: fn => on('privacy', fn), onRemotePlayOnDesktop: fn => on('remote', fn),
  onMpvState: fn => on('player', fn), onMpvEnded: fn => on('ended', fn), onMpvError: fn => on('player-error', fn),
  onPlayerShortcut: fn => on('shortcut', fn), onAiSearchEvent: fn => on('ai', fn),
  getVideoAnalysisJob: async () => ({ running: true, jobId: 'profile-job', videoPath: videos[0].fullPath,
    lastEvent: { status: 'running', message: '分析中' } }),
  onVideoAnalysisEvent: fn => on('analysis', fn), listSavedVideoAnalysis: async () => ({ success: true, results: [] }),
  getVideoAnalysis: async () => ({ available: false }),
  generateThumbnail: async () => ({ thumbPath: image }), getThumbnailUrl: async () => image,
  getVideoMetadata: async () => ({ success: true, media: { available: true, durationSeconds: 120 } }),
  cancelMediaWork: async () => ({ success: true }), getFileUrl: async () => 'data:video/mp4,',
  getPlaybackState: async () => ({ position: 0 }), savePlaybackState: async () => ({ success: true }),
  mpvStop: async () => ({ success: true }), setMediaPlaybackActive: async () => ({ success: true }),
  playerAction: async input => {
    if (input.action === 'stop') return { success: true, sessionId: input.sessionId }
    if (input.action === 'load') nativeState = { sessionId: input.sessionId, engineSessionId: ++engine,
      resourceTarget: input.target, filePath: input.target, timePos: 0, duration: 120, paused: false,
      ready: true, volume: 100, muted: false, speed: 1, eofReached: false, trackList: [] }
    emit('player', nativeState)
    return { success: true, sessionId: input.sessionId, state: nativeState }
  }
}
window.__audit = {
  videos, errors, profiles, renders, actions,
  reset() { profiles.length = 0; renders.length = 0 },
  analysis(index) { emit('analysis', { videoPath: videos[0].fullPath, jobId: 'profile-job', status: 'running', message: '分析进度 ' + index, stage: 'profile-' + index }) },
  playback(index) { nativeState = { ...nativeState, timePos: index }; emit('player', nativeState) },
  settings(patch) { settings = { ...settings, ...patch }; emit('settings', clone(settings)) },
  listeners() { return Object.fromEntries([...listeners].map(([key, values]) => [key, values.size])) }
}
const root = createRoot(document.getElementById('root'))
window.__audit.unmount = () => root.unmount()
const suspended = new Promise(() => {})
function CommitGate() {
  const [blocked, setBlocked] = React.useState(false)
  window.__audit.block = setBlocked
  if (blocked) throw suspended
  return null
}
window.__audit.suspendSettings = () => React.startTransition(() => {
  window.__audit.settings({ favorites: [videos[0].favoriteKey] })
  window.__audit.block(true)
})
root.render(<React.Suspense fallback={<div>等待测试提交</div>}><App /><CommitGate /></React.Suspense>)
