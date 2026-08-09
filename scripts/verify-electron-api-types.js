const assert = require('assert')
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const preloadSource = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf-8')
const dtsSource = fs.readFileSync(path.join(projectRoot, 'src', 'electronAPI.d.ts'), 'utf-8')
const channelsSource = fs.readFileSync(path.join(projectRoot, 'main', 'ipc-channels.js'), 'utf-8')

// ─── 1. preload 方法名 ↔ electronAPI.d.ts 双向一致 ────────────────
const preloadNames = [...preloadSource.matchAll(/^\s{2}(\w+):\s*\(/gm)]
  .map(match => match[1])
  .filter(name => name !== 'on')

const dtsNames = [...dtsSource.matchAll(/^\s{2}(\w+)\s*\(/gm)]
  .map(match => match[1])
  .filter(name => name !== 'export')

const missingInDts = preloadNames.filter(name => !dtsNames.includes(name))
const staleInDts = dtsNames.filter(name => !preloadNames.includes(name))

assert.deepStrictEqual(
  missingInDts,
  [],
  `preload.js 暴露了但 electronAPI.d.ts 缺少的 API: ${missingInDts.join(', ')}`
)
assert.deepStrictEqual(
  staleInDts,
  [],
  `electronAPI.d.ts 声明了但 preload.js 已不存在的 API: ${staleInDts.join(', ')}`
)

// ─── 2. preload 通道字符串 ↔ main/ipc-channels.js 常量值一致 ─────
// preload 运行在沙箱上下文，无法 require 本地模块，只能以字符串书写通道名；
// 因此这里强制 preload 中的每个通道字符串都能在常量表里找到。
const preloadChannels = new Set([
  ...[...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/gm)].map(match => match[1]),
  ...[...preloadSource.matchAll(/\bon\('([^']+)'/gm)].map(match => match[1])
])

const constantsSource = channelsSource
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
const constantValues = new Set(
  [...constantsSource.matchAll(/:\s*'([^']+)'/gm)].map(match => match[1])
)

// 插件通道由插件自持，不属于常量表；列出以跳过
const PLUGIN_OWNED_CHANNELS = new Set([
  'video-analysis-get',
  'video-analysis-list-saved',
  'video-analysis-delete-saved',
  'video-analysis-start',
  'video-analysis-cancel',
  'video-analysis-job',
  'video-analysis-get-output-dir',
  'video-analysis-select-output-dir',
  'video-analysis-open-output-dir',
  'video-analysis-get-model-dir',
  'video-analysis-get-default-model-dir',
  'video-analysis-select-model-dir',
  'video-analysis-open-model-dir',
  'video-analysis-get-runtime-config',
  'video-analysis-save-runtime-config',
  'video-analysis-reset-runtime-config',
  'video-analysis-vlm-state',
  'video-analysis-vlm-model-options',
  'video-analysis-vlm-save-config',
  'video-analysis-vlm-select-model-file',
  'video-analysis-vlm-select-server-executable',
  'video-analysis-vlm-local-list-files',
  'video-analysis-vlm-local-select-file',
  'video-analysis-vlm-download',
  'video-analysis-vlm-start',
  'video-analysis-vlm-stop',
  'video-analysis-event',
  'video-analysis-vlm-event',
  'ai-search-start',
  'ai-search-cancel',
  'ai-search-feedback',
  'ai-search-event'
])

const unlistedChannels = [...preloadChannels]
  .filter(channel => !constantValues.has(channel) && !PLUGIN_OWNED_CHANNELS.has(channel))
  .sort()

assert.deepStrictEqual(
  unlistedChannels,
  [],
  `preload.js 使用的通道在 main/ipc-channels.js 常量表中缺失: ${unlistedChannels.join(', ')}`
)

const staleConstants = [...constantValues]
  .filter(value => !preloadChannels.has(value) && !PLUGIN_OWNED_CHANNELS.has(value))
  .sort()

assert.deepStrictEqual(
  staleConstants,
  [],
  `main/ipc-channels.js 常量值在 preload.js 中已无引用: ${staleConstants.join(', ')}`
)

console.log(
  `[verify:electron-api] ${preloadNames.length} preload APIs match electronAPI.d.ts; ` +
  `${preloadChannels.size} preload channels match ipc-channels.js`
)
