// Render the selected vector with the project's Chromium, then build platform assets.
// No network requests, image service or additional dependency is needed.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
async function render() {
  const { app, BrowserWindow } = require('electron')
  const profile = process.env.WALLPAPER_ICON_PROFILE
  assert.ok(profile && path.basename(profile).startsWith('wallpaper-icons-'))
  app.setPath('userData', profile); app.setPath('sessionData', profile)
  await app.whenReady()
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  try {
    await window.loadURL('data:text/html,<html><head><meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:"></head></html>')
    const source = await fs.readFile(path.join(root, 'src/assets/app-icon.svg'), 'utf8')
    const defs = source.match(/<defs>[\s\S]*?<\/defs>/)[0]
    const mark = source.slice(source.indexOf('  <g fill='), source.lastIndexOf('</svg>'))
    const squareBackground = '<rect width="1024" height="1024" fill="url(#ac-2)"/><rect width="1024" height="1024" fill="url(#sh-2)" opacity="0.6"/>'
    const svg = body => '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">' + defs + body + '</svg>'
    const foreground = '<g transform="translate(512 512) scale(0.78) translate(-512 -512)">' + mark + '</g>'
    const monochrome = '<defs><mask id="shape"><g fill="white"><rect x="222" y="222" width="272" height="272" rx="76"/><rect x="530" y="222" width="272" height="272" rx="76"/><rect x="222" y="530" width="272" height="272" rx="76"/><rect x="530" y="530" width="272" height="272" rx="76"/></g><path d="M628 597 L628 735 L746 666 Z" fill="black" stroke="black" stroke-width="32" stroke-linejoin="round"/></mask></defs><g transform="translate(512 512) scale(0.78) translate(-512 -512)"><rect width="1024" height="1024" fill="white" mask="url(#shape)"/></g>'
    async function png(vector, size) {
      const data = await window.webContents.executeJavaScript('(' + (async (url, size) => {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size
        canvas.getContext('2d').drawImage(image, 0, 0, size, size)
        return canvas.toDataURL('image/png').split(',')[1]
      }).toString() + ')(' + JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(vector).toString('base64')) + ',' + size + ')')
      const bytes = Buffer.from(data, 'base64'); assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size)
      return bytes
    }
    const frames = []
    for (const size of sizes) frames.push(await png(source, size))
    const header = Buffer.alloc(6 + frames.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4)
    let offset = header.length
    frames.forEach((bytes, index) => {
      const at = 6 + index * 16, size = sizes[index]
      header[at] = size === 256 ? 0 : size; header[at + 1] = header[at]
      header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(bytes.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += bytes.length
    })
    await fs.mkdir(path.join(root, 'mobile/assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...frames]))
    await fs.writeFile(path.join(root, 'build/icon.png'), await png(source, 256))
    for (const [name, vector] of [['icon', svg(squareBackground + mark)], ['adaptive-background', svg(squareBackground)], ['adaptive-foreground', svg(foreground)], ['adaptive-monochrome', svg(monochrome)]])
      await fs.writeFile(path.join(root, 'mobile/assets', name + '.png'), await png(vector, 1024))
    console.log('Generated Windows ICO (' + sizes.join('/') + 'px), window PNG and Android/iOS icons from src/assets/app-icon.svg')
  } finally { window.destroy(); app.quit() }
}
async function main() {
  const profile = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'wallpaper-icons-'))
  await fs.writeFile(path.join(profile, '.wallpaper-icon-owner.json'), JSON.stringify({ root, purpose: 'isolated vector rasterization' }))
  const env = { ...process.env, WALLPAPER_ICON_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
  const result = await require('node:util').promisify(require('node:child_process').execFile)(require('electron'), [__filename], { cwd: root, env, windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 })
  console.log(result.stdout.trim())
}
if (process.versions.electron) render().catch(error => { console.error(error); require('electron').app.exit(1) })
else main().catch(error => { console.error(error); process.exitCode = 1 })
