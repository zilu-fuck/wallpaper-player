// 回归验证：legacy path-key 标签在路径大小写/realpath 差异下的兼容性。
// 背景：verify-remote-library-flow 在 CI（Windows runner，D:\a\_temp 路径）
// 上失败——旧数据以字面量路径为 customTags 键写入，而解析走 realpath
// 规范化，两者大小写不一致时键匹配失败，bulk 打标签会丢失 legacy 标签。
// 修复后按 pathKey 归一化匹配，本脚本验证该行为在所有环境稳定。
const assert = require('assert')
const { collectLegacyTagEntries } = require('../main/remote/handlers/tags')

// CI 场景：fixture 以字面量路径写入 legacy 键，realpath 后大小写不同
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

console.log('legacy path-key 标签兼容性验证通过')
