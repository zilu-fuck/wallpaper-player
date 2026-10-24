const { withAppBuildGradle } = require('@expo/config-plugins')

const marker = '// @generated begin wallpaper-windows-cmake-object-path'
const configuration = `
        ${marker}
        externalNativeBuild {
            cmake {
                if (System.getProperty('os.name').toLowerCase().contains('windows')) {
                    arguments '-DCMAKE_OBJECT_PATH_MAX=250'
                }
            }
        }
        // @generated end wallpaper-windows-cmake-object-path
`

module.exports = function withWindowsCmakePaths(config) {
  return withAppBuildGradle(config, nextConfig => {
    const result = nextConfig.modResults
    if (result.language !== 'groovy') throw new Error('Windows CMake path configuration requires a Groovy app build.gradle')
    if (result.contents.includes(marker)) return nextConfig
    const anchor = /\bdefaultConfig\s*\{/
    if (!anchor.test(result.contents)) throw new Error('Cannot find Android defaultConfig for Windows CMake path configuration')
    // CMake hashes long object paths before Ninja reaches the Windows filename limit.
    result.contents = result.contents.replace(anchor, match => match + configuration)
    return nextConfig
  })
}
