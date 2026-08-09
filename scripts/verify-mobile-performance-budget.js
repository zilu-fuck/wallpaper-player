const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function includes(text, expected, message) {
  assert.ok(text.includes(expected), message)
}

function matches(text, pattern, message) {
  assert.ok(pattern.test(text), message)
}

const qaDoc = read('docs/mobile-real-device-qa.md')
const qaScript = read('scripts/qa-mobile-real-device.ps1')
const playerScreen = read('mobile/src/screens/PlayerScreen.tsx')

includes(qaDoc, '## 性能预算', 'real-device QA should define explicit performance budgets')
includes(qaDoc, '1k 视频库', 'real-device QA should cover 1k library performance')
includes(qaDoc, '5k 视频库', 'real-device QA should cover 5k library performance')
includes(qaDoc, '60 分钟播放', 'real-device QA should cover 60-minute playback')
includes(qaDoc, '低内存恢复', 'real-device QA should cover low-memory recovery')
includes(qaDoc, '切后台/锁屏', 'real-device QA should cover background and lock-screen recovery')
includes(qaDoc, '弱网重连', 'real-device QA should cover weak-network reconnects')
includes(qaDoc, 'performance-budget.json', 'real-device QA should require the budget artifact')

matches(qaScript, /\[ValidateSet\("library-1k", "library-5k", "playback-60m", "low-memory-restore", "background-lock", "weak-network", "custom"\)\]/, 'QA capture should expose stable scenario names')
includes(qaScript, 'MaxPssGrowthMb', 'QA capture should enforce PSS growth budgets')
includes(qaScript, 'MaxFinalPssMb', 'QA capture should enforce final PSS budgets')
includes(qaScript, 'performance-budget.json', 'QA capture should write a machine-readable budget result')
includes(qaScript, 'automaticPass', 'QA capture should summarize automatic budget pass/fail')
includes(qaScript, 'send-trim-memory', 'QA capture should support Android low-memory restore checks')
includes(qaScript, 'DesktopPollSeconds', 'QA capture should poll desktop health during long runs')

matches(playerScreen, /useVideoPlayer\(/, 'mobile player should keep one shared native player')
matches(playerScreen, /windowSize=\{3\}/, 'mobile player feed should keep a small virtualization window')
matches(playerScreen, /initialNumToRender=\{3\}/, 'mobile player should not render a large feed upfront')
matches(playerScreen, /maxToRenderPerBatch=\{3\}/, 'mobile player should cap render batches')
matches(playerScreen, /removeClippedSubviews=\{Platform\.OS === 'android'\}/, 'Android player feed should clip offscreen pages')

console.log('mobile performance budget verification passed')
