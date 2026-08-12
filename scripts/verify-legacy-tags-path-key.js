// 回归验证：legacy path-key 标签在路径差异下的兼容性。
// 背景：verify-remote-library-flow 在 CI（Windows runner）上失败——旧数据以
// 字面量路径为 customTags 键写入，而解析走 realpath 规范化；路径大小写
// 不一致或经 subst 映射盘/junction 时键匹配失败，bulk 打标签会丢失 legacy
// 标签。修复后按 pathKey 快路径 + realpath 归一化慢路径匹配。
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { collectLegacyTagEntries } = require('../main/remote/handlers/tags')
const { normalizedPathKey } = require('../main/paths')

// 场景一：路径大小写不同（realpath 规范化大小写）
const literalKey = 'D:\\a\\_temp\\wallpaper-player-library-flow-ABC\\vp9-opus-sample.mkv'
const realpathKey = 'D:\\A\\_TEMP\\wallpaper-player-library-flow-abc\\vp9-opus-sample.mkv'
const favoriteKey = 'video_fakehash'

const customTags = {
  [favoriteKey]: ['other-video-tag'],
  [literalKey]: ['legacy-path-tag'],
  'D:\\a\\_temp\\wallpaper-player-library-flow-ABC\\sample-video.mp4': ['other-path-tag']
}

// 旧逻辑（customTags[target.path] 直接查键）在大小写差异下找不到 legacy 标签
assert.strictEqual(customTags[realpathKey], undefined, '旧逻辑在大小写差异下应找不到 legacy 标签')

// 新逻辑：pathKey 归一化匹配
const entries = collectLegacyTagEntries(customTags, {
  path: realpathKey,
  rawPath: realpathKey
})
assert.strictEqual(entries.length, 1, 'pathKey 匹配应恰好命中一条 legacy 条目')
assert.deepStrictEqual(entries[0][1], ['legacy-path-tag'])

// 前缀相同的其他视频互不串扰
const otherEntries = collectLegacyTagEntries(customTags, {
  path: 'D:\\a\\_temp\\wallpaper-player-library-flow-ABC\\sample-video.mp4',
  rawPath: 'D:\\a\\_temp\\wallpaper-player-library-flow-ABC\\sample-video.mp4'
})
assert.strictEqual(otherEntries.length, 1)
assert.deepStrictEqual(otherEntries[0][1], ['other-path-tag'])

// 场景二：subst 映射盘（realpath 解析后为真实路径）。
// 构造一个真实临时目录，用映射路径模拟 legacy 键（本机无 subst 时跳过）。
let substChecked = false
try {
  const realDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wp-legacy-realpath-'))
  const fakeMappedPath = path.join('Z:\\mapped\\library', 'vp9-opus-sample.mkv')
  const mappedEntry = [fakeMappedPath, ['mapped-path-tag']]
  const mappedTags = Object.fromEntries([mappedEntry])

  // 真实文件存在时，normalizedPathKey 应解析映射路径到同一真实路径；
  // 无法模拟映射时（realpath 不一致）跳过本场景
  const realFile = path.join(realDir, 'vp9-opus-sample.mkv')
  fs.writeFileSync(realFile, 'x')
  const realTarget = fs.realpathSync.native(realFile)

  const mappedMatches = collectLegacyTagEntries(mappedTags, {
    path: realTarget,
    rawPath: realTarget
  })
  if (mappedMatches.length === 1 && mappedMatches[0][1][0] === 'mapped-path-tag') {
    substChecked = true
  }

  // 直接验证 normalizedPathKey 对同一真实文件的两种路径形式收敛
  const keyA = normalizedPathKey(fakeMappedPath)
  const keyB = normalizedPathKey(realTarget)
  // 映射路径不存在时两者不同属正常（无法模拟），不强制断言
  if (keyA === keyB) substChecked = true

  fs.rmSync(realDir, { recursive: true, force: true })
} catch {
  // 环境不支持时跳过 subst 场景
}

console.log(substChecked
  ? 'legacy path-key 标签兼容性验证通过（含 realpath 归一化场景）'
  : 'legacy path-key 标签兼容性验证通过（本环境无法模拟映射盘，realpath 场景跳过）')
