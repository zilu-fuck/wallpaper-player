const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
const launcher = fs.readFileSync(path.join(projectRoot, 'scripts', 'start-electron-direct.js'), 'utf-8')

assert.match(packageJson.scripts.start, /node scripts\/start-electron-direct\.js/)
assert.match(packageJson.scripts.rebuild, /node scripts\/start-electron-direct\.js/)
assert.strictEqual(packageJson.scripts['start:direct'], 'node scripts/start-electron-direct.js')
assert.match(launcher, /require\('electron'\)/)
assert.match(launcher, /detached:\s*true/)
assert.match(launcher, /child\.unref\(\)/)

console.log('direct startup verification passed')
