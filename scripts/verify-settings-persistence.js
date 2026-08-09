const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-settings-'))

async function main() {
  process.chdir(tempRoot)
  const {
    flushSettingsWrites,
    loadSettings,
    saveSettings,
    saveSettingsAndFlush
  } = require(path.join(projectRoot, 'main', 'settings'))

  saveSettings({ theme: 'light' })
  saveSettings({ playbackMode: 'shuffle' })
  const saved = await saveSettingsAndFlush({ hiddenTags: ['system:test'] })

  assert.strictEqual(saved.theme, 'light')
  assert.strictEqual(saved.playbackMode, 'shuffle')
  assert.deepStrictEqual(saved.hiddenTags, ['system:test'])

  await flushSettingsWrites()
  const settingsPath = path.join(tempRoot, '.tmp-wallpaper-player', 'settings.json')
  const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  assert.strictEqual(persisted.theme, 'light')
  assert.strictEqual(persisted.playbackMode, 'shuffle')
  assert.deepStrictEqual(persisted.hiddenTags, ['system:test'])
  assert.deepStrictEqual(loadSettings(), persisted)

  const temporaryFiles = fs.readdirSync(path.dirname(settingsPath)).filter(name => name.endsWith('.tmp'))
  assert.deepStrictEqual(temporaryFiles, [])
  console.log('settings persistence verification passed')
}

main()
  .finally(() => {
    process.chdir(projectRoot)
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
