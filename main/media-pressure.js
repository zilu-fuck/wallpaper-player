const { EventEmitter } = require('events')
const events = new EventEmitter()
const leases = new Set()
let desktopActive = false
function getMediaPressure() { return { desktopActive, remoteStreams: leases.size, active: desktopActive || leases.size > 0 } }
function publish() { events.emit('change', getMediaPressure()) }
function setDesktopPlaybackActive(active) {
  const next = Boolean(active)
  if (desktopActive !== next) { desktopActive = next; publish() }
}
function acquireRemoteStream() {
  const lease = Symbol('remote-stream'); leases.add(lease); publish()
  return () => { if (leases.delete(lease)) publish() }
}
function onMediaPressureChanged(listener) { events.on('change', listener); return () => events.off('change', listener) }
module.exports = { acquireRemoteStream, getMediaPressure, onMediaPressureChanged, setDesktopPlaybackActive }
