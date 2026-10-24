const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http')
const { phone } = require('./mobile-module-harness')
const gate = require('./release-gate.cjs')
const root = path.resolve(__dirname, '..'), checks = []
const clone = value => JSON.parse(JSON.stringify(value))
const environment = { platform: 'android', applicationId: 'com.wallpaperplayer.mobile', version: '0.1.4', versionCode: 5,
  supportedAbis: ['arm64-v8a', 'armeabi-v7a'], sdkVersion: 36, certificateSha256: ['a'.repeat(64)] }
const published = '2026-10-23T00:00:00.000Z', commit = 'b'.repeat(40)
let fixture, contractManifest, api, web, modules
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value) }
async function check(name, run) { await run(); checks.push(name) }
function load() {
  const value = phone()
  value.stubs['expo/fetch'] = { fetch }
  value.stubs.expo = { requireOptionalNativeModule: () => ({ getEnvironment: async () => clone(environment) }) }
  value.control.globals = { TextDecoder, Uint8Array }
  return { phone: value, updates: value.load('mobile/src/services/updates.ts'), manifest: value.load('mobile/src/services/update-manifest.ts'), native: value.load('mobile/src/services/update-environment.ts') }
}
const asset = (tag, name, size, sha256) => ({ name, size, state: 'uploaded', digest: sha256 ? 'sha256:' + sha256 : null, browser_download_url: `${web}/download/${tag}/${name}` })
function release(manifest, overrides = {}) {
  const item = { draft: false, prerelease: false, tag_name: manifest.tag, name: 'Desktop ' + manifest.desktopVersion, published_at: published,
    assets: manifest.assets.map(item => asset(manifest.tag, item.file, item.bytes, item.sha256)) }
  item.assets.push(asset(manifest.tag, 'release-manifest.json', Buffer.byteLength(JSON.stringify(manifest))))
  return { ...item, ...overrides }
}
const desktop = tag => ({ draft: false, prerelease: false, tag_name: tag, name: tag, published_at: published, assets: [] })
function retag(manifest, tag) {
  const value = clone(manifest), previous = value.desktopVersion
  value.tag = tag; value.desktopVersion = tag.slice(1)
  value.platforms.find(item => item.platform === 'windows').version = value.desktopVersion
  for (const item of value.assets) {
    if (item.platform === 'windows') item.file = item.file.replace(previous, value.desktopVersion)
    item.url = `${web}/download/${tag}/${item.file}`
  }
  return value
}
function transport(releases, manifests = new Map([[contractManifest.tag, contractManifest]])) {
  const calls = []
  const fetch = async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, undefined)
    if (url.startsWith(api + '?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      assert.equal(new URL(url).searchParams.get('per_page'), '20')
      return Response.json(releases.slice((page - 1) * 20, page * 20))
    }
    for (const [tag, manifest] of manifests) if (url === `${web}/download/${tag}/release-manifest.json`) return Response.json(manifest)
    throw new Error('unexpected network request ' + url)
  }
  return { calls, fetch }
}
const checker = (network, env = environment, extra = {}) => modules.updates.createMobileUpdateChecker({ fetch: network.fetch, environment: async () => clone(env), ...extra })
async function fromManifest(manifest, env = environment, options) {
  const network = transport([release(manifest)], new Map([[manifest.tag, manifest]]))
  return checker(network, env)('9.9.9', options)
}
async function makeContractManifest() {
  const version = '1.2.3', mobileVersion = '0.2.0', source = path.join(fixture, 'source')
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x14c, 68)
  for (const file of [`Wallpaper-Player-Setup-${version}.exe`, `Wallpaper-Player-${version}.exe`]) await write(path.join(source, file), pe)
  await write(path.join(source, `Wallpaper-Player-Setup-${version}.exe.blockmap`), 'bounded blockmap fixture')
  const hash = await gate.hashFile(path.join(source, `Wallpaper-Player-Setup-${version}.exe`))
  await write(path.join(source, 'latest.yml'), `version: ${version}\nfiles:\n  - url: Wallpaper-Player-Setup-${version}.exe\n    sha512: ${hash.sha512}\n    size: ${hash.bytes}\npath: Wallpaper-Player-Setup-${version}.exe\nsha512: ${hash.sha512}\n`)
  const integrity = { packages: {} }
  for (const id of ['video-analysis', 'ai-search', 'agent-bridge']) {
    const file = path.join(source, 'plugins', `Wallpaper-Player-Plugin-${id}-1.0.0.zip`)
    await write(file, Buffer.from('504b0304' + Buffer.from(id).toString('hex'), 'hex'))
    integrity.packages[id] = { version: '1.0.0', sha256: (await gate.hashFile(file)).sha256 }
  }
  const windows = await gate.collectWindows({ directory: source, version, sourceCommit: commit, integrity,
    inspectVersion: () => ({ productVersion: version, signatureStatus: 'NotSigned' }) })
  const apk = path.join(fixture, 'fixture.apk'); await write(apk, 'bounded unsigned test fixture')
  const expected = { version: mobileVersion, versionCode: 6, applicationId: environment.applicationId, abi: 'arm64-v8a', certificateSha256: environment.certificateSha256[0], minServerProtocol: 1, clientProtocol: require('../packages/contracts').PROTOCOL_VERSION }
  const android = await gate.collectAndroid({ apk, expected, sourceCommit: commit,
    inspect: () => ({ ...expected, abi: ['arm64-v8a'], minSdk: 24, targetSdk: 36, verified: true, debugCertificate: false }) })
  const directories = { windows: path.join(fixture, 'windows'), android: path.join(fixture, 'android') }
  await gate.stagePart(windows, source, directories.windows)
  await gate.stagePart(android, null, directories.android, apk)
  const plan = { mode: 'desktop-and-android', desktopVersion: version, desktopSigning: { required: false }, android: expected, tag: 'v' + version }
  const results = Object.fromEntries(['plan', 'verify', 'build-windows', 'build-mobile-apk'].map(name => [name, { result: 'success' }]))
  const value = await gate.assembleRelease({ plan, results, directories, sourceCommit: commit, repository: 'zilu-fuck/wallpaper-player' })
  await write(path.join(fixture, 'producer-manifest.json'), JSON.stringify(value.manifest, null, 2))
  return value.manifest
}
async function main() {
  fixture = await fs.mkdtemp(path.join(root, '.tmp/refactor-tests/mobile-updates-'))
  modules = load(); api = modules.manifest.RELEASE_API; web = 'https://github.com/zilu-fuck/wallpaper-player/releases'
  contractManifest = await makeContractManifest()
  await check('actual release-gate assembler manifest is consumed; desktop tag never becomes mobile version', async () => {
    const info = await fromManifest(contractManifest)
    assert.equal(info.available, true); assert.equal(info.currentVersion, '0.1.4'); assert.equal(info.latestVersion, '0.2.0')
    assert.equal(info.versionCode, 6); assert.equal(info.sha256, contractManifest.assets.find(item => item.role === 'android-apk').sha256)
    assert.equal(info.clientProtocol, require('../packages/contracts').PROTOCOL_VERSION)
    assert.ok(info.downloadUrl.endsWith('wallpaper-player-mobile-0.2.0-arm64-release.apk'))
  })
  await check('desktop-only releases and pagination preserve the older compatible mobile release', async () => {
    const releases = Array.from({ length: 20 }, (_, index) => desktop('v9.0.' + index)).concat(release(contractManifest))
    const network = transport(releases), info = await checker(network)('0.1.4')
    assert.equal(info.available, true); assert.equal(network.calls.filter(item => item.url.startsWith(api)).length, 2)
  })
  await check('mobile version code, not release order or desktop tag, selects the latest compatible APK', async () => {
    const older = retag(contractManifest, 'v8.0.0'); older.platforms.find(item => item.platform === 'android').versionCode = 5
    const network = transport([release(older), release(contractManifest)], new Map([[older.tag, older], [contractManifest.tag, contractManifest]]))
    assert.equal((await checker(network)('0.1.4')).versionCode, 6)
  })
  for (const [name, patch] of [
    ['wrong platform ABI', item => { item.abi = ['x86_64'] }],
    ['wrong application identity', item => { item.applicationId = 'com.other.app' }],
    ['wrong signing certificate', item => { item.certificateSha256 = 'c'.repeat(64) }],
    ['newer minimum Android SDK', item => { item.minSdk = 37; item.targetSdk = 37 }],
    ['newer server protocol requirement', item => { item.minServerProtocol = 2 }]
  ]) await check(name + ' cannot advertise an update', async () => {
    const value = clone(contractManifest); patch(value.platforms.find(item => item.platform === 'android'))
    if (name === 'wrong platform ABI') {
      const asset = value.assets.find(item => item.role === 'android-apk')
      asset.file = asset.file.replace('arm64', 'x86_64'); asset.url = `${web}/download/${value.tag}/${asset.file}`
    }
    await assert.rejects(fromManifest(value), /兼容/)
  })
  await check('explicit server protocol allows a compatible protocol2 release; default remains legacy compatible', async () => {
    const value = clone(contractManifest); value.platforms.find(item => item.platform === 'android').minServerProtocol = 2
    assert.equal((await fromManifest(value, environment, { serverProtocol: 2 })).available, true)
    await assert.rejects(fromManifest(value, environment, { serverProtocol: NaN }), /无效的电脑协议/)
  })
  await check('known public APK pin survives desktop-only latest; current version returns no download', async () => {
    const raw = require('./fixtures/mobile-release-list.json')
    const env = { ...environment, version: '0.1.3', versionCode: 4, certificateSha256: ['fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'] }
    const result = await checker(transport(raw), env)('0.1.3')
    assert.equal(result.latestVersion, '0.1.4'); assert.equal(result.available, true); assert.equal(result.metadata, 'pinned-legacy')
    const current = await checker(transport(raw), { ...env, version: '0.1.4', versionCode: 5 })('0.1.4')
    assert.equal(current.available, false); assert.equal(current.downloadUrl, '')
    await write(path.join(fixture, 'public-snapshot-result.json'), JSON.stringify({ result, current }, null, 2))
  })
  await check('legacy assets require exact pinned tag, bytes and GitHub SHA256', async () => {
    const pin = require('../mobile/src/services/legacy-mobile-releases.json')[0]
    const raw = { ...desktop(pin.tag), assets: [asset(pin.tag, pin.file, pin.bytes, pin.sha256)] }
    for (const patch of [item => { item.assets[0].size++ }, item => { item.assets[0].digest = null }, item => { item.assets[0].digest = 'sha256:' + '0'.repeat(64) }]) {
      const value = clone(raw); patch(value)
      await assert.rejects(checker(transport([value]))('0.1.4'), /摘要|发布资产/)
    }
  })
  await check('manifest version, commit, tag, signature claims, asset bytes/hash and URL must agree', async () => {
    const mutations = [
      item => { item.schemaVersion = 2 }, item => { item.tag = 'v7.0.0' }, item => { item.sourceCommit = 'bad' },
      item => { item.platforms.find(value => value.platform === 'android').signatureVerified = false },
      item => { item.platforms.find(value => value.platform === 'android').debugCertificate = true },
      item => { item.platforms.find(value => value.platform === 'android').clientProtocol = 0 },
      item => { item.assets.find(value => value.role === 'android-apk').url = 'https://evil.invalid/payload.apk' },
      item => { item.assets.push(clone(item.assets.find(value => value.role === 'android-apk'))) }
    ]
    for (const mutate of mutations) {
      const value = clone(contractManifest), original = release(value); mutate(value)
      await assert.rejects(checker(transport([original], new Map([[original.tag_name, value]])))('0.1.4'), /元数据/)
    }
    const raw = release(contractManifest); raw.assets.find(item => item.name.endsWith('.apk')).size++
    await assert.rejects(checker(transport([raw]))('0.1.4'), /发布资产/)
    raw.assets.find(item => item.name.endsWith('.apk')).digest = 'sha256:' + 'f'.repeat(64)
    await assert.rejects(checker(transport([raw]))('0.1.4'), /发布资产/)
  })
  await check('malicious URLs, path aliases, duplicate assets and invalid stable versions fail closed', async () => {
    for (const mutate of [
      item => { item.tag_name = 'v1.2.3/../evil' }, item => { item.assets.find(value => value.name.endsWith('.apk')).browser_download_url = 'https://github.com.evil.invalid/payload.apk' },
      item => { item.assets.push(clone(item.assets.find(value => value.name.endsWith('.apk')))) }, item => { item.assets.find(value => value.name.endsWith('.apk')).name = '../payload.apk' }
    ]) { const raw = release(contractManifest); mutate(raw); await assert.rejects(checker(transport([raw]))('0.1.4'), /元数据/) }
    for (const pair of [['0.1.4-beta', '0.1.4'], ['01.2.3', '1.2.3'], ['1.2', '1.2.0'], ['1.2.3.4', '1.2.3']]) assert.throws(() => modules.manifest.compareVersions(...pair), /元数据/)
  })
  await check('draft, prerelease and IPA-only releases are ignored; iOS never receives an APK', async () => {
    const ipa = { ...desktop('v8.0.0'), assets: [asset('v8.0.0', 'wallpaper-player-mobile-9.9.9.ipa', 99)] }
    const network = transport([release(contractManifest, { draft: true }), release(contractManifest, { prerelease: true }), ipa, release(contractManifest)])
    assert.equal((await checker(network)('0.1.4')).latestVersion, '0.2.0')
    modules.phone.stubs['react-native'].Platform.OS = 'ios'
    await assert.rejects(modules.native.readUpdateEnvironment(), /当前平台/)
    modules.phone.stubs['react-native'].Platform.OS = 'android'
  })
  await check('native identity is mandatory; neither JS version nor missing/multiple signing identities can override it', async () => {
    const result = await fromManifest(contractManifest)
    assert.equal(result.currentVersion, environment.version)
    for (const changed of [{ certificateSha256: [] }, { certificateSha256: ['a'.repeat(64), 'b'.repeat(64)] }, { supportedAbis: [] }, { versionCode: NaN }]) await assert.rejects(checker(transport([release(contractManifest)]), { ...environment, ...changed })('0.1.4'), /元数据/)
    modules.phone.stubs.expo.requireOptionalNativeModule = () => null
    await assert.rejects(modules.native.readUpdateEnvironment(), /缺少更新环境模块/)
  })
  await check('versionCode rollback, inconsistent versionName and same-code different files cannot be advertised', async () => {
    const value = clone(contractManifest); value.platforms.find(item => item.platform === 'android').versionCode = 5
    await assert.rejects(fromManifest(value), /版本名与递增版本码/)
    const older = retag(contractManifest, 'v7.0.0'); older.assets.find(item => item.role === 'android-apk').sha256 = 'd'.repeat(64)
    await assert.rejects(checker(transport([release(older), release(contractManifest)], new Map([[older.tag, older], [contractManifest.tag, contractManifest]])))('0.1.4'), /相同版本码/)
  })
  await check('unknown newer legacy APK and malformed manifest never silently fall back to an older current result', async () => {
    const raw = { ...desktop('v7.0.0'), assets: [asset('v7.0.0', 'wallpaper-player-mobile-0.9.0-arm64-release.apk', 99)] }
    await assert.rejects(checker(transport([raw]))('0.1.4'), /缺少可验证清单/)
    const bad = clone(contractManifest); bad.schemaVersion = 8
    await assert.rejects(checker(transport([release(bad), release(contractManifest)], new Map([[bad.tag, bad]])))('0.1.4'), /元数据/)
  })
  await check('incompatible newer release is reported instead of claiming the older current build is latest', async () => {
    const old = retag(contractManifest, 'v6.0.0'); old.platforms.find(item => item.platform === 'android').certificateSha256 = 'f'.repeat(64)
    const raw = require('./fixtures/mobile-release-list.json')
    const env = { ...environment, certificateSha256: ['fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'] }
    await assert.rejects(checker(transport([release(old), ...raw], new Map([[old.tag, old]])), env)('0.1.4'), /不兼容/)
  })
  await check('HTTP errors, invalid JSON and incomplete pagination return errors', async () => {
    for (const status of [403, 404, 429, 500]) await assert.rejects(checker({ fetch: async () => new Response('failed', { status }) })('0.1.4'), new RegExp(String(status)))
    await assert.rejects(checker({ fetch: async () => new Response('{') })('0.1.4'), /JSON|property/i)
    const endless = transport(Array.from({ length: 100 }, (_, index) => desktop('v9.1.' + index)))
    await assert.rejects(checker(endless)('0.1.4'), /超出检查范围/)
    assert.equal(endless.calls.length, 5)
    const manifests = Array.from({ length: 21 }, (_, index) => retag(contractManifest, 'v5.0.' + index))
    const budget = transport(manifests.map(item => release(item)), new Map(manifests.map(item => [item.tag, item])))
    await assert.rejects(checker(budget)('0.1.4'), /超出检查范围/)
    assert.equal(budget.calls.filter(item => item.url.endsWith('/release-manifest.json')).length, 20)
  })
  await check('list and manifest streaming limits cancel the reader even without content-length', async () => {
    let cancelled = 0
    const large = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) }, cancel() { cancelled++ } }))
    await assert.rejects(checker({ fetch: async () => large() })('0.1.4'), /大小上限/)
    assert.equal(cancelled, 1)
    const network = transport([release(contractManifest)])
    await assert.rejects(checker({ fetch: async (url, options) => url.startsWith(api) ? network.fetch(url, options) : large() })('0.1.4'), /大小上限/)
    assert.equal(cancelled, 2)
    await assert.rejects(checker({ fetch: async () => new Response('[]', { headers: { 'content-length': '999999999' } }) })('0.1.4'), /大小上限/)
  })
  await check('one deadline covers native metadata, headers and stalled response bodies; caller abort is preserved', async () => {
    await assert.rejects(checker({ fetch: async () => new Promise(() => {}) }, environment, { timeoutMs: 25 })('0.1.4'), /超时/)
    await assert.rejects(checker({ fetch }, environment, { timeoutMs: 25, environment: async () => new Promise(() => {}) })('0.1.4'), /超时/)
    let cancelled = 0
    await assert.rejects(checker({ fetch: async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled++ } })) }, environment, { timeoutMs: 25 })('0.1.4'), /超时/)
    assert.equal(cancelled, 1)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(checker({ fetch: async () => { throw new Error('must not fetch') } })('0.1.4', { signal: controller.signal }), { name: 'AbortError' })
  })
  await check('real local HTTP transport streams release and manifest data without downloading the APK', async () => {
    const requests = [], server = http.createServer((req, res) => {
      requests.push(req.url); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined)
      const body = req.url.startsWith('/list') ? [release(contractManifest)] : contractManifest
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const text = JSON.stringify(body); res.write(text.slice(0, 37)); setImmediate(() => res.end(text.slice(37)))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const endpoint = 'http://127.0.0.1:' + server.address().port
      const info = await checker({ fetch: (url, options) => fetch(endpoint + (url.startsWith(api) ? '/list' : '/manifest'), options) })('0.1.4')
      assert.equal(info.available, true); assert.deepEqual(requests, ['/list', '/manifest'])
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
  const report = { passed: true, checks, fixture, producerManifestSha256: crypto.createHash('sha256').update(JSON.stringify(contractManifest)).digest('hex'),
    scope: 'Production TS modules in isolated VM; actual release-gate assembler output, frozen public metadata and local streaming HTTP. No APK downloaded, installed or published by this verifier.' }
  await write(path.join(fixture, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); console.error('Retained update fixture:', fixture); process.exitCode = 1 })
