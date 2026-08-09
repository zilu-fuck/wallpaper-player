const path = require('path')
const { app } = require('electron')

// 用户数据目录的唯一实现。
// 注意：plugins/video-analysis 作为独立打包插件自带一份副本，改这里时需同步。
const fallbackUserDataDir = path.join(process.cwd(), '.tmp-wallpaper-player')

function getUserDataDir() {
  return app?.getPath ? app.getPath('userData') : fallbackUserDataDir
}

module.exports = { getUserDataDir }
