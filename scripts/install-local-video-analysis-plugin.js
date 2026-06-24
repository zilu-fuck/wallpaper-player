const path = require('path')
const { app } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const installedUserData = path.join(app.getPath('appData'), 'wallpaper-player')

async function main() {
  app.setPath('userData', installedUserData)
  const { disposePlugins, installPlugin, setupPlugins } = require(path.join(projectRoot, 'main', 'plugins'))
  const pluginZip = path.join(projectRoot, 'release', 'plugins', 'Wallpaper-Player-Plugin-video-analysis-1.0.0.zip')

  await setupPlugins()
  const result = await installPlugin(pluginZip)
  if (!result?.success) {
    throw new Error(result?.error || 'video-analysis plugin install failed')
  }
  await disposePlugins()
  console.log(`installed ${result.plugin.id} into ${installedUserData} from ${pluginZip}`)
}

app.whenReady()
  .then(main)
  .finally(() => {
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
    app.quit()
  })
