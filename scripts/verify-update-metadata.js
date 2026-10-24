const assert = require('assert')
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider')
const yaml = require('js-yaml')

const info = parseUpdateInfo([
  'version: 1.5.1',
  'files:',
  '  - url: Wallpaper-Player-Setup-1.5.1.exe',
  '    sha512: fixture-digest',
  '    size: 1234',
  'releaseDate: 2026-10-14T00:00:00.000Z',
  'releaseNotes: |',
  '  修复与更新说明'
].join('\n'), 'latest.yml', 'https://example.invalid/latest.yml')
assert.strictEqual(info.version, '1.5.1')
assert.strictEqual(info.files[0].url, 'Wallpaper-Player-Setup-1.5.1.exe')
assert.ok(info.releaseNotes.includes('修复与更新说明'))
assert.throws(() => parseUpdateInfo('invalid: [', 'latest.yml', 'https://example.invalid/latest.yml'))
assert.throws(() => yaml.load('empty: &empty {}\nmerged: { <<: [*empty, *empty, *empty] }', {
  maxTotalMergeKeys: 1
}), /merge|limit|exceed/i, 'patched YAML parser must count empty merge sources against its work budget')
console.log('update metadata verification passed: valid release YAML, malformed input and empty merge limits')
