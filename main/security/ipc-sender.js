const path = require('path')
const { fileURLToPath } = require('url')

const windows = new WeakMap()
const denied = () => Object.assign(new Error('ipc_sender_denied: 调用来源无效，请重新打开应用窗口'), {
  code: 'ipc_sender_denied', status: 403, retryable: false
})

function createAppEntryMatcher(entryUrl) {
  const entry = new URL(entryUrl)
  if (entry.username || entry.password || entry.search || entry.hash) throw new Error('应用入口地址无效')
  const localFile = entry.protocol === 'file:'
  if (!localFile && !(entry.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(entry.hostname))) {
    throw new Error('应用入口必须是本地文件或开发服务')
  }
  const fileKey = value => {
    const resolved = path.resolve(fileURLToPath(value))
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const expectedFile = localFile ? fileKey(entry) : null
  return value => {
    try {
      const candidate = new URL(value)
      if (candidate.username || candidate.password || candidate.search || candidate.protocol !== entry.protocol) return false
      return localFile ? fileKey(candidate) === expectedFile
        : candidate.origin === entry.origin && candidate.pathname === entry.pathname
    } catch { return false }
  }
}

// Only the main process chooses an entry. Renderer messages cannot bind or change this policy.
function bindAppWindow(win, entryUrl) {
  const contents = win.webContents, matches = createAppEntryMatcher(entryUrl)
  windows.get(contents)?.dispose()
  const record = { win, matches, generation: 0, ready: matches(contents.getURL()) }
  const invalidate = () => { record.generation++; record.ready = false }
  const started = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate() }
  const committed = (_event, url) => { record.ready = matches(url) && matches(contents.getURL()) }
  const destroyed = () => { invalidate(); record.dispose() }
  record.dispose = () => {
    invalidate()
    if (windows.get(contents) === record) windows.delete(contents)
    contents.removeListener('did-start-navigation', started)
    contents.removeListener('did-navigate', committed)
    contents.removeListener('render-process-gone', invalidate)
    contents.removeListener('destroyed', destroyed)
  }
  windows.set(contents, record)
  contents.on('did-start-navigation', started)
  contents.on('did-navigate', committed)
  contents.on('render-process-gone', invalidate)
  contents.once('destroyed', destroyed)
  return record.dispose
}

function guardAppNavigation(contents, entryUrl, openExternal) {
  const matches = createAppEntryMatcher(entryUrl)
  const navigate = (event, url) => {
    if (matches(url)) return
    event.preventDefault()
    try {
      const target = new URL(url)
      if (target.protocol === 'http:' || target.protocol === 'https:') openExternal?.(url)
    } catch {}
  }
  const redirect = (event, url, _inPlace, mainFrame) => { if (mainFrame && !matches(url)) event.preventDefault() }
  contents.on('will-navigate', navigate)
  contents.on('will-redirect', redirect)
  return () => {
    contents.removeListener('will-navigate', navigate)
    contents.removeListener('will-redirect', redirect)
  }
}

function captureAppSender(event) {
  const sender = event?.sender, frame = event?.senderFrame
  const record = sender && windows.get(sender), generation = record?.generation
  function assertCurrent() {
    try {
      const main = require('../window').getMainWindow()
      if (!record || windows.get(sender) !== record || record.generation !== generation || !record.ready ||
        main !== record.win || main.isDestroyed() || sender.isDestroyed() || sender !== main.webContents ||
        !frame || frame.detached || frame !== sender.mainFrame || !record.matches(frame.url) || !record.matches(sender.getURL())) {
        throw denied()
      }
    } catch { throw denied() }
  }
  assertCurrent()
  return { assertCurrent }
}

module.exports = { createAppEntryMatcher, bindAppWindow, guardAppNavigation, captureAppSender }
