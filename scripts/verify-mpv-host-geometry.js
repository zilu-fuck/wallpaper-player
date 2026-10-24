const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
let zoom = 1, content = { x: 200, y: 100, width: 1366, height: 768 }, host, mainVisible = true, mainMinimized = false, focusCalls = 0
class Window extends EventEmitter {
  constructor(options) { super(); this.bounds = options; this.visible = false; host = this }
  isDestroyed() { return false }
  setIgnoreMouseEvents() {}
  setBounds(bounds) { this.bounds = bounds }
  isVisible() { return this.visible }
  show() { this.visible = true }
  showInactive() { this.visible = true }
  hide() { this.visible = false }
  focus() { focusCalls++ }
  destroy() { this.emit('closed') }
}
const main = Object.assign(new EventEmitter(), {
  isDestroyed: () => false, isVisible: () => mainVisible, isMinimized: () => mainMinimized,
  getContentBounds: () => content, webContents: { getZoomFactor: () => zoom }
})
const loaded = { exports: {} }
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/mpv-host.js'), 'utf8'), {
  module: loaded, require(name) {
    if (name === 'electron') return { BaseWindow: Window }
    if (name === './window') return { getMainWindow: () => main }
    throw Error('Unexpected import ' + name)
  }, process
}, { filename: 'main/mpv-host.js' })
const api = loaded.exports
api.setMpvHostMainWindow(main)
const surface = { x: 31.25, y: 90.125, width: 1012.5, height: 449.25 }
for (zoom of [0.75, 1, 1.25, 1.5, 2]) {
  assert.equal(api.setMpvHostBounds(surface), true)
  assert.equal(api.showMpvHostWindow(), true)
  const b = host.bounds, left = Math.ceil(surface.x * zoom), top = Math.ceil(surface.y * zoom)
  assert.equal(b.x, content.x + left)
  assert.equal(b.y, content.y + top)
  assert.equal(b.width, Math.min(content.width, Math.floor((surface.x + surface.width) * zoom)) - left)
  assert.equal(b.height, Math.min(content.height, Math.floor((surface.y + surface.height) * zoom)) - top)
  assert.ok(b.x >= content.x && b.y >= content.y)
  assert.ok(b.x + b.width <= content.x + content.width && b.y + b.height <= content.y + content.height)
}
zoom = 1.25
api.setMpvHostBounds({ x: -10.5, y: -8.5, width: 100, height: 100 })
assert.equal(host.bounds.x, content.x); assert.equal(host.bounds.y, content.y)
content = { ...content, x: 500, y: 400 }
main.emit('move'); assert.equal(host.bounds.x, 500); assert.equal(host.bounds.y, 400)
api.setMpvHostBounds({ x: 5000, y: 5000, width: 100, height: 100 })
assert.equal(host.visible, false, 'offscreen geometry must hide the previous native rectangle')
assert.equal(api.showMpvHostWindow(), false)
api.setMpvHostBounds(surface); api.showMpvHostWindow()
assert.equal(host.visible, true)
assert.equal(api.setMpvHostBounds({ ...surface, x: NaN }), false)
mainVisible = false; main.emit('hide')
assert.equal(host.visible, false)
mainVisible = true; main.emit('show')
assert.equal(host.visible, true, 'a requested native picture must reappear when its parent is shown')
mainMinimized = true; main.emit('minimize')
assert.equal(host.visible, false)
api.setMpvHostBounds(surface); api.showMpvHostWindow()
assert.equal(host.visible, false, 'bounds updates cannot show a native picture above a minimized parent')
mainMinimized = false; main.emit('restore')
assert.equal(host.visible, true)
api.hideMpvHostWindow(true); main.emit('show')
assert.equal(host.visible, false, 'a stopped or explicitly hidden host must stay hidden after parent restoration')
assert.equal(focusCalls, 0, 'showing and moving video must not focus the native child over the application renderer')
api.destroyMpvHostWindow()
assert.equal(main.eventNames().length, 0, 'geometry listeners are removed on native host destruction')
console.log('mpv host geometry passed: fractional CSS coordinates, 75–200% zoom, clipping, movement, parent hide/minimize/restore ownership, no child focus and listener cleanup')
