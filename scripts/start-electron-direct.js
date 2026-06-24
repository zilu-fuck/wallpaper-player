const { spawn } = require('child_process')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const electronPath = require('electron')

const child = spawn(electronPath, [projectRoot], {
  cwd: projectRoot,
  detached: true,
  stdio: 'ignore',
  windowsHide: false
})

child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

child.unref()
console.log(`Wallpaper Player started with Electron PID ${child.pid}`)
