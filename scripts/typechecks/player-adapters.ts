import { MpvAdapter, Html5Adapter } from '../../src/api/player'
import type { PlayerAction } from '../../packages/contracts'

const native = new MpvAdapter()
native.seek(0)
native.command({ command: 'setVolume', value: 0 })
native.command({ command: 'setPaused', value: true })
// @ts-expect-error volume cannot be a string
native.command({ command: 'setVolume', value: 'zero' })
// @ts-expect-error pause requires a boolean
native.command({ command: 'setPaused', value: 0 })
// @ts-expect-error arbitrary mpv commands cannot cross the bridge
native.command({ command: 'run', value: 'unsafe' })
const valid: PlayerAction = { action: 'command', sessionId: 'current', command: { command: 'seekTo', value: 0 } }
window.electronAPI.playerAction(valid)
// @ts-expect-error scoped controls require a session
window.electronAPI.playerAction({ action: 'stop' })
const html5 = new Html5Adapter()
html5.load('video://source', { position: 0, volume: 0, muted: true })
// @ts-expect-error restore position must be numeric
html5.load('video://source', { position: 'zero' })
