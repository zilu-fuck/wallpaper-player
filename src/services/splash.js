// Launch presentation owns no IPC, application state or media resources.
export const SPLASH_ID = 'app-splash'
const MIN_VISIBLE_MS = 1800
const FADE_MS = 700
const REDUCED_VISIBLE_MS = 100
const REDUCED_FADE_MS = 160

let deadlineTimer = 0
let leaveTimer = 0
let removeTimer = 0
let dismissed = false
let deadlineReached = false
let template = null
let replayBound = false
let disposeMotion = () => {}

function reducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

function readDelayLeft() {
  const startedAt = window.__splashStartedAt
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) return 0
  const now = window.__splashClock === 'date' ? Date.now() : window.performance?.now?.()
  if (!Number.isFinite(now)) return 0
  const minimum = reducedMotion() ? REDUCED_VISIBLE_MS : MIN_VISIBLE_MS
  return Math.max(0, minimum - Math.max(0, now - startedAt))
}

function setWorkbenchPhase(phase) {
  document.documentElement?.classList.toggle('splash-workbench-pending', phase === 'pending')
  document.documentElement?.classList.toggle('splash-workbench-entering', phase === 'entering')
  const root = document.getElementById('root')
  if (root) root.inert = phase !== 'ready'
}

function bindMotion(splash) {
  disposeMotion()
  const tilt = splash.querySelector?.('.splash-tilt')
  if (!tilt || !window.matchMedia) return
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
  let frame = 0
  let pointer = null
  const reset = () => {
    window.cancelAnimationFrame(frame)
    frame = 0
    pointer = null
    tilt.style.removeProperty('--splash-tilt-x')
    tilt.style.removeProperty('--splash-tilt-y')
  }
  const move = event => {
    if (media.matches || !fine.matches || event.pointerType === 'touch' || splash.classList.contains('is-leaving')) return
    pointer = { x: event.clientX, y: event.clientY }
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (!pointer) return
      const x = Math.max(-1, Math.min(1, pointer.x / window.innerWidth * 2 - 1))
      const y = Math.max(-1, Math.min(1, pointer.y / window.innerHeight * 2 - 1))
      tilt.style.setProperty('--splash-tilt-x', `${(-y * 6).toFixed(2)}deg`)
      tilt.style.setProperty('--splash-tilt-y', `${(x * 7).toFixed(2)}deg`)
    })
  }
  splash.addEventListener('pointermove', move, { passive: true })
  splash.addEventListener('pointerleave', reset)
  window.addEventListener('blur', reset)
  media.addEventListener('change', reset)
  disposeMotion = () => {
    reset()
    splash.removeEventListener('pointermove', move)
    splash.removeEventListener('pointerleave', reset)
    window.removeEventListener('blur', reset)
    media.removeEventListener('change', reset)
    disposeMotion = () => {}
  }
}

export function dismissSplash() {
  if (dismissed) return
  dismissed = true
  window.clearTimeout(deadlineTimer)
  deadlineTimer = 0
  const splash = document.getElementById(SPLASH_ID)
  if (!splash) { setWorkbenchPhase('ready'); return }
  leaveTimer = window.setTimeout(() => {
    leaveTimer = 0
    disposeMotion()
    splash.classList.add('is-leaving')
    setWorkbenchPhase('entering')
    removeTimer = window.setTimeout(() => {
      removeTimer = 0
      splash.remove()
      setWorkbenchPhase('ready')
    }, reducedMotion() ? REDUCED_FADE_MS : FADE_MS)
  }, deadlineReached ? 0 : readDelayLeft())
}

export function replaySplash() {
  if (!template || document.querySelector('.player-overlay, .overlay, dialog[open]')) return
  window.clearTimeout(deadlineTimer)
  window.clearTimeout(leaveTimer)
  window.clearTimeout(removeTimer)
  deadlineTimer = leaveTimer = removeTimer = 0
  disposeMotion()
  document.getElementById(SPLASH_ID)?.remove()
  const splash = template.cloneNode(true)
  document.body.appendChild(splash)
  dismissed = deadlineReached = false
  window.__splashStartedAt = window.__splashClock === 'date' ? Date.now() : window.performance.now()
  setWorkbenchPhase('pending')
  watchSplash()
}

// The deadline follows the original boot clock, including stalled rAF or IPC.
export function watchSplash() {
  if (typeof window === 'undefined' || dismissed || deadlineTimer) return
  const splash = document.getElementById(SPLASH_ID)
  if (splash) {
    template ||= splash.cloneNode?.(true) || null
    setWorkbenchPhase('pending')
    bindMotion(splash)
  }
  if (!replayBound) {
    const button = document.getElementById('app-splash-replay')
    if (button?.addEventListener) { button.addEventListener('click', replaySplash); replayBound = true }
  }
  deadlineTimer = window.setTimeout(() => {
    deadlineReached = true
    dismissSplash()
  }, readDelayLeft())
}

export function rememberThemeHint(theme) {
  const mode = theme === 'light' ? 'light' : 'dark'
  try { document.documentElement.setAttribute('data-theme', mode) } catch {}
  try { window.localStorage.setItem('wallpaper-player:theme', mode) } catch {}
}
