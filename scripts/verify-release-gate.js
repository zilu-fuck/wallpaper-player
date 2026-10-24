const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const gate = require('./release-gate.cjs')
const { publishPreparedRelease, ghAdapter } = require('./release-publish.cjs')
const { signApk } = require('./sign-release-apk.cjs')
const root = path.resolve(__dirname, '..')
const clone = value => JSON.parse(JSON.stringify(value))
const sha = 'a'.repeat(40), cert = 'b'.repeat(64)
const base = { tag: 'v1.2.3', desktop: { version: '1.2.3' }, mobile: { version: '0.2.0' }, app: { expo: { version: '0.2.0', android: { package: 'com.example.player', versionCode: 7 } } },
  policy: { schemaVersion: 1, desktopArch: 'x64', desktopSigning: { required: false, certificateSha256: null }, android: { abi: 'arm64-v8a', minServerProtocol: 1, signingState: 'ready', certificateSha256: cert,
    previous: { applicationId: 'com.example.player', versionCode: 6, certificateSha256: cert, debugCertificate: false } } },
  env: Object.fromEntries(['ANDROID_RELEASE_KEYSTORE_BASE64', 'ANDROID_RELEASE_STORE_PASSWORD', 'ANDROID_RELEASE_KEY_ALIAS', 'ANDROID_RELEASE_KEY_PASSWORD'].map(name => [name, 'test-only-present'])) }
async function run() {
  const fixture = fs.mkdtempSync(path.join(root, '.tmp/refactor-tests/release-gate-')), checks = []
  const desktop = gate.makePlan({ ...base, includeMobile: false, env: {} }), joint = gate.makePlan({ ...base, includeMobile: true })
  assert.equal(joint.android.clientProtocol, require('../packages/contracts').PROTOCOL_VERSION)
  assert.equal(desktop.mode, 'desktop'); assert.equal(joint.android.versionCode, 7)
  for (const tag of ['v9.9.9', 'main', 'v1.2.3;echo bad', 'v1.2.3\nextra']) assert.throws(() => gate.makePlan({ ...base, tag }), /tag/)
  assert.throws(() => gate.makePlan({ ...base, tag: 'v01.2.3', desktop: { version: '01.2.3' } }), /stable semantic version/)
  for (const field of Object.keys(base.env)) assert.throws(() => gate.makePlan({ ...base, includeMobile: true, env: { ...base.env, [field]: '' } }), /missing ANDROID_RELEASE/)
  const legacy = clone(base); legacy.policy.android.previous.debugCertificate = true
  assert.throws(() => gate.makePlan({ ...legacy, includeMobile: true }), /Debug identity/)
  const changedSigner = clone(base); changedSigner.policy.android.certificateSha256 = 'c'.repeat(64)
  assert.throws(() => gate.makePlan({ ...changedSigner, includeMobile: true }), /signing identity changed/)
  const downgrade = clone(base); downgrade.app.expo.android.versionCode = 6
  assert.throws(() => gate.makePlan({ ...downgrade, includeMobile: true }), /versionCode must increase/)
  const unready = clone(base); unready.policy.android.signingState = 'migration-required'
  assert.throws(() => gate.makePlan({ ...unready, includeMobile: true }), /signing migration is not ready/)
  const signedWindows = clone(base); signedWindows.policy.desktopSigning = { required: true, certificateSha256: cert }
  assert.throws(() => gate.makePlan(signedWindows), /Windows signing credentials/)
  assert.doesNotThrow(() => gate.makePlan({ ...signedWindows, env: { ...base.env, WINDOWS_CSC_LINK: 'qa-only', WINDOWS_CSC_KEY_PASSWORD: 'qa-only' } }))
  const missingWindowsPolicy = clone(base); delete missingWindowsPolicy.policy.desktopSigning
  assert.throws(() => gate.makePlan(missingWindowsPolicy), /signing requirement must be explicit/)
  checks.push('tag/version/mode checks; missing signing secrets, legacy debug identity, signer change, version downgrade and unready migration states fail closed')
  let combinations = 0
  for (const plan of [desktop, joint]) for (const preflight of ['success', 'failure', 'cancelled', 'skipped']) for (const verify of ['success', 'failure', 'cancelled', 'skipped']) for (const win of ['success', 'failure', 'cancelled', 'skipped']) for (const android of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = { plan: { result: preflight }, verify: { result: verify }, 'build-windows': { result: win }, 'build-mobile-apk': { result: android } }
    const allowed = preflight === 'success' && verify === 'success' && win === 'success' && android === (plan.mode === 'desktop' ? 'skipped' : 'success')
    if (allowed) assert.doesNotThrow(() => gate.assertJobResults(plan, result)); else assert.throws(() => gate.assertJobResults(plan, result))
    combinations++
  }
  checks.push('all512 desktop/joint success/failure/cancelled/skipped combinations require preflight and the intended successful jobs')
  const directory = path.join(fixture, 'source'); fs.mkdirSync(path.join(directory, 'plugins'), { recursive: true })
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x14c, 68)
  for (const name of ['Wallpaper-Player-Setup-1.2.3.exe', 'Wallpaper-Player-1.2.3.exe']) fs.writeFileSync(path.join(directory, name), pe)
  fs.writeFileSync(path.join(directory, 'Wallpaper-Player-Setup-1.2.3.exe.blockmap'), 'bounded blockmap fixture')
  const installer = await gate.hashFile(path.join(directory, 'Wallpaper-Player-Setup-1.2.3.exe'))
  const yaml = `version: 1.2.3\nfiles:\n  - url: Wallpaper-Player-Setup-1.2.3.exe\n    sha512: ${installer.sha512}\n    size: ${installer.bytes}\npath: Wallpaper-Player-Setup-1.2.3.exe\nsha512: ${installer.sha512}\n`
  fs.writeFileSync(path.join(directory, 'latest.yml'), yaml)
  const integrity = { packages: {} }
  for (const id of ['video-analysis', 'ai-search', 'agent-bridge']) {
    const file = path.join(directory, 'plugins', `Wallpaper-Player-Plugin-${id}-1.0.0.zip`)
    fs.writeFileSync(file, Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.from(id)]))
    integrity.packages[id] = { version: '1.0.0', sha256: (await gate.hashFile(file)).sha256 }
  }
  const options = { directory, version: '1.2.3', sourceCommit: sha, integrity, inspectVersion: () => ({ productVersion: '1.2.3.0', signatureStatus: 'NotSigned' }) }
  const winPart = await gate.collectWindows(options)
  assert.equal(winPart.assets.length, 7)
  await assert.rejects(gate.collectWindows({ ...options, inspectVersion: () => ({ productVersion: '9.9.9' }) }), /product version/)
  await assert.rejects(gate.collectWindows({ ...options, inspectVersion: () => ({ productVersion: '1.2.3', signatureStatus: 'HashMismatch' }) }), /signature/)
  await assert.rejects(gate.collectWindows({ ...options, signing: { required: true, certificateSha256: cert } }), /reviewed identity/)
  await assert.doesNotReject(gate.collectWindows({ ...options, signing: { required: true, certificateSha256: cert },
    inspectVersion: () => ({ productVersion: '1.2.3', signatureStatus: 'Valid', certificateSha256: cert }) }))
  fs.writeFileSync(path.join(directory, 'latest.yml'), yaml.replace('size: 128', 'size: 129'))
  await assert.rejects(gate.collectWindows(options), /update files/)
  fs.writeFileSync(path.join(directory, 'latest.yml'), yaml)
  const badIntegrity = clone(integrity); badIntegrity.packages['ai-search'].sha256 = '0'.repeat(64)
  await assert.rejects(gate.collectWindows({ ...options, integrity: badIntegrity }), /plugin archive hash/)
  for (const name of ['../outside', 'file.', 'bad:stream', 'bad/name', 'a\nb']) assert.throws(() => gate.fileName(name), /invalid artifact name/)
  checks.push('Windows PE/version resource, update YAML hash/size, plugin archive integrity and artifact names validated')
  const apk = path.join(fixture, 'signed-fixture.apk'); fs.writeFileSync(apk, 'synthetic signed artifact bytes; signature inspector is injected for these policy cases')
  const androidMetadata = { ...joint.android, version: '0.2.0', abi: ['arm64-v8a'], minSdk: 24, targetSdk: 36, debugCertificate: false, verified: true }
  const androidOptions = { apk, expected: joint.android, sourceCommit: sha, inspect: () => clone(androidMetadata) }
  const apkPart = await gate.collectAndroid(androidOptions)
  await assert.rejects(gate.collectAndroid({ ...androidOptions, expected: { ...androidOptions.expected, clientProtocol: joint.android.clientProtocol + 1 } }), /built shared contract/)
  for (const change of [{ debugCertificate: true }, { certificateSha256: 'c'.repeat(64) }, { applicationId: 'wrong.app' }, { versionCode: 6 }, { abi: ['x86_64'] }, { verified: false }]) {
    await assert.rejects(gate.collectAndroid({ ...androidOptions, inspect: () => ({ ...androidMetadata, ...change }) }))
  }
  checks.push('APK policy rejects debug/unverified signatures, changed certificate/application/versionCode and wrong ABI')
  const windows = path.join(fixture, 'windows'), android = path.join(fixture, 'android')
  await gate.stagePart(winPart, directory, windows); await gate.stagePart(apkPart, null, android, apk)
  const statuses = { plan: { result: 'success' }, verify: { result: 'success' }, 'build-windows': { result: 'success' }, 'build-mobile-apk': { result: 'success' } }
  const assembly = { plan: joint, results: statuses, directories: { windows, android }, sourceCommit: sha, repository: 'example/player' }
  const candidate = await gate.assembleRelease(assembly)
  assert.equal(candidate.manifest.platforms.find(item => item.platform === 'android').clientProtocol, joint.android.clientProtocol)
  const androidPartPath = path.join(android, 'part.json'), originalAndroidPart = fs.readFileSync(androidPartPath)
  const mismatchedProtocol = JSON.parse(originalAndroidPart); mismatchedProtocol.clientProtocol++
  fs.writeFileSync(androidPartPath, JSON.stringify(mismatchedProtocol))
  await assert.rejects(gate.assembleRelease(assembly), /clientProtocol/)
  fs.writeFileSync(androidPartPath, originalAndroidPart)
  assert.equal(candidate.files.length, 8); assert.equal(candidate.manifest.assets.length, 8)
  const desktopOnly = await gate.assembleRelease({ ...assembly, plan: desktop, results: { ...statuses, 'build-mobile-apk': { result: 'skipped' } } })
  assert.equal(desktopOnly.files.length, 7)
  const target = path.join(windows, winPart.assets[0].file); fs.appendFileSync(target, 'tampered')
  await assert.rejects(gate.assembleRelease(assembly), /hash\/size mismatch/)
  fs.writeFileSync(target, pe)
  await assert.rejects(gate.assembleRelease({ ...assembly, sourceCommit: 'd'.repeat(40) }), /provenance/)
  await assert.rejects(gate.assembleRelease({ ...assembly, sourceCommit: 'd'.repeat(41) }), /invalid source commit/)
  const partFile = path.join(windows, 'part.json'), preservedPart = fs.readFileSync(partFile)
  const wrongMetadata = JSON.parse(preservedPart); wrongMetadata.assets[0].productVersion = '9.9.9'
  fs.writeFileSync(partFile, JSON.stringify(wrongMetadata))
  await assert.rejects(gate.assembleRelease(assembly), /executable metadata/)
  fs.writeFileSync(partFile, preservedPart)
  checks.push('desktop/joint inventories assemble separately; transfer tampering and commit mismatch cannot reach publication')
  const manifestFile = path.join(fixture, 'release-manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(candidate.manifest))
  const allFiles = [...candidate.files, { name: 'release-manifest.json', path: manifestFile }]
  const fake = ({ existing = null, failUpload = false, corruptDownload = false, unexpected = false } = {}) => {
    const state = { release: existing, files: [], published: 0, calls: [] }
    const adapter = {
      async view() { state.calls.push('view'); return state.release },
      async createDraft({ body }) { state.calls.push('draft'); state.release = { isDraft: true, body } },
      async assets() { return [...state.files.map(item => ({ name: item.name, size: item.bytes })), ...(unexpected ? [{ name: 'foreign.txt', size: 1 }] : [])] },
      async upload(tag, file) { if (failUpload) throw Error('synthetic upload failure'); state.calls.push('upload:' + file.name); state.files.push(file) },
      async download(tag, name, output) { state.calls.push('download:' + name); const file = allFiles.find(item => item.name === name); await fsp.copyFile(file.path, path.join(output, name)); if (corruptDownload) fs.appendFileSync(path.join(output, name), 'corrupt') },
      async publish() { state.calls.push('publish'); state.published++; state.release.isDraft = false }
    }
    return { state, adapter }
  }
  const invoke = async scenario => { const verificationDirectory = fs.mkdtempSync(path.join(fixture, 'download-')); return publishPreparedRelease({ tag: joint.tag, title: 'Fixture', notes: 'Fixture notes\nsecond line', files: candidate.files, manifestFile, adapter: scenario.adapter, verificationDirectory }) }
  const normal = fake(); assert.equal((await invoke(normal)).assets, 9); assert.equal(normal.state.published, 1)
  assert.ok(normal.state.calls.lastIndexOf('publish') > normal.state.calls.lastIndexOf('download:release-manifest.json'))
  const callsBeforeRetry = normal.state.calls.length
  assert.equal((await invoke(normal)).alreadyPublished, true)
  assert.equal(normal.state.published, 1)
  assert.ok(!normal.state.calls.slice(callsBeforeRetry).some(item => item.startsWith('upload:') || item === 'draft' || item === 'publish'))
  for (const scenario of [fake({ failUpload: true }), fake({ corruptDownload: true }), fake({ unexpected: true }), fake({ existing: { isDraft: false } }), fake({ existing: { isDraft: true, body: 'human draft' } })]) {
    await assert.rejects(invoke(scenario)); assert.equal(scenario.state.published, 0)
  }
  const resumed = fake(); resumed.state.release = { isDraft: true, body: '<!-- wallpaper-release-manifest:' + (await gate.hashFile(manifestFile)).sha256 + ' -->' }
  resumed.state.files.push({ ...candidate.files[0] }); await invoke(resumed); assert.equal(resumed.state.published, 1)
  checks.push('only an owned draft is resumed; upload/download/inventory failure preserves an unpublished draft and public/unowned releases cannot be clobbered')
  const commandCalls = []
  const adapter = ghAdapter({ repository: 'example/player', temporaryDirectory: fixture, exec: (binary, args, options) => { commandCalls.push({ binary, args }); assert.equal(options.windowsHide, true); throw Error('synthetic auth/network failure') } })
  await assert.rejects(adapter.view('v1.2.3'), /auth\/network/); assert.equal(commandCalls.length, 1)
  const keystore = Buffer.from('synthetic secret material'), output = path.join(fixture, 'unused.apk')
  let keyFile
  assert.throws(() => signApk({ apk, output, encodedKeystore: keystore.toString('base64'), alias: 'qa', temporaryRoot: fixture,
    tools: { sdk: fixture, java: 'java' }, env: {}, exec: (binary, args) => { keyFile = args[args.indexOf('--ks') + 1]; assert.ok(fs.existsSync(keyFile)); assert.ok(args.includes('env:ANDROID_RELEASE_STORE_PASSWORD')); throw Error('synthetic signing failure') } }), /synthetic signing failure/)
  assert.equal(fs.existsSync(keyFile), false)
  checks.push('GitHub lookup errors do not create releases; signing failures erase only the owned temporary keystore and pass passwords by environment name')
  const workflow = require('js-yaml').load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'))
  const bootstrap = path.join(fixture, 'no-installed-dependencies')
  for (const file of ['scripts/release-gate.cjs', 'scripts/release-policy.json', 'package.json', 'mobile/package.json', 'mobile/app.json',
    'packages/contracts/package.json', 'packages/contracts/dist/index.js', 'packages/contracts/dist/schema.js', 'packages/contracts/dist/settings-feed.js']) {
    const target = path.join(bootstrap, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file), target)
  }
  const bootstrapPlan = JSON.parse(require('node:child_process').execFileSync(process.execPath, ['scripts/release-gate.cjs', 'plan'], {
    cwd: bootstrap, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v' + require('../package.json').version,
      RELEASE_INCLUDE_MOBILE: 'false', GITHUB_OUTPUT: '' } }))
  assert.equal(bootstrapPlan.mode, 'desktop')
  assert.equal(fs.existsSync(path.join(bootstrap, 'node_modules')), false)
  checks.push('shared client protocol reaches the manifest, mismatched transferred protocol is rejected and preflight runs without npm installation')
  assert.equal(workflow.permissions.contents, 'read'); assert.equal(workflow.jobs.publish.permissions.contents, 'write')
  assert.deepEqual(workflow.jobs.publish.needs, ['plan', 'verify', 'build-windows', 'build-mobile-apk'])
  for (const id of ['plan', 'verify', 'build-windows', 'build-mobile-apk']) assert.ok(!(workflow.jobs[id].steps || []).some(step => /release-publish|gh release/.test(step.run || '')))
  assert.equal(workflow.jobs.verify.uses, './.github/workflows/ci.yml')
  const core = require('js-yaml').load(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'))
  assert.ok(Object.hasOwn(core.on, 'workflow_call'))
  assert.equal(core.jobs['verify-lan'].needs, 'verify-core')
  assert.ok(workflow.jobs.publish.steps.some(step => step.run === 'node scripts/release-publish.cjs'))
  assert.ok(workflow.jobs.publish.if.includes("needs.build-mobile-apk.result == 'success'"))
  assert.ok(workflow.jobs['build-mobile-apk'].steps.some(step => step.run === 'node scripts/sign-release-apk.cjs'))
  checks.push('actual workflow uses a single write-permission publisher after both build dependencies, with Android signing before staging')
  console.log(JSON.stringify({ checks, jobStatusCombinations: combinations, fixture, scope: 'Pure candidate policy/filesystem behavior and an injected GitHub adapter; no external release or production key used' }))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
