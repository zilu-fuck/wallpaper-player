const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { PROTOCOL_VERSION: clientProtocol } = require('../packages/contracts')

const root = path.resolve(__dirname, '..')
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const fingerprint = /^[a-f0-9]{64}$/
const fail = message => { throw new Error('Release gate: ' + message) }
const check = (condition, message) => { if (!condition) fail(message) }
function readJson(file) {
  check(fs.statSync(file).size <= 1024 * 1024, 'metadata is too large')
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''))
}
function fileName(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) && !value.endsWith('.'), 'invalid artifact name')
  return value
}
function artifactFile(directory, relative) {
  check(typeof relative === 'string' && !path.isAbsolute(relative), 'expected relative artifact path')
  const parts = relative.split(/[\\/]/)
  parts.forEach(fileName)
  let current = path.resolve(directory)
  check(!fs.lstatSync(current).isSymbolicLink(), 'artifact root must not be linked')
  for (const part of parts) {
    current = path.join(current, part)
    check(!fs.lstatSync(current).isSymbolicLink(), 'artifact paths must not be linked')
  }
  check(fs.statSync(current).isFile(), 'artifact must be a regular file')
  return current
}
async function hashFile(file) {
  const sha256 = crypto.createHash('sha256'), sha512 = crypto.createHash('sha512')
  let bytes = 0
  for await (const chunk of fs.createReadStream(file)) { sha256.update(chunk); sha512.update(chunk); bytes += chunk.length }
  check(bytes > 0 && Number.isSafeInteger(bytes), 'artifact must have bounded nonzero bytes')
  return { bytes, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}
function makePlan({ tag, includeMobile = false, desktop, mobile, app, policy, env = {}, requireSigningSecrets = true }) {
  check(stableVersion.test(desktop.version), 'desktop version must be a stable semantic version')
  check(tag === 'v' + desktop.version, 'tag must exactly match the desktop package version')
  check(typeof includeMobile === 'boolean', 'mobile release mode must be explicit')
  check(policy.schemaVersion === 1 && policy.desktopArch === 'x64', 'unsupported release policy')
  check(policy.desktopSigning && typeof policy.desktopSigning.required === 'boolean', 'Windows signing requirement must be explicit')
  const plan = { schemaVersion: 1, tag, mode: includeMobile ? 'desktop-and-android' : 'desktop', desktopVersion: desktop.version, desktopArch: policy.desktopArch }
  plan.desktopSigning = policy.desktopSigning
  if (plan.desktopSigning.required) {
    check(fingerprint.test(plan.desktopSigning.certificateSha256 || ''), 'reviewed Windows signing identity is missing')
    if (requireSigningSecrets) check(env.WINDOWS_CSC_LINK && env.WINDOWS_CSC_KEY_PASSWORD, 'Windows signing credentials are missing')
  }
  if (includeMobile) {
    const problems = []
    const android = policy.android, previous = android?.previous
    if (android?.abi !== 'arm64-v8a' || !Number.isSafeInteger(android?.minServerProtocol) || android.minServerProtocol < 1) problems.push('invalid Android ABI/protocol policy')
    if (typeof app.expo?.android?.package !== 'string' || !/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(app.expo.android.package)) problems.push('invalid Android applicationId')
    if (previous && (!Number.isSafeInteger(previous.versionCode) || previous.versionCode < 1 || !fingerprint.test(previous.certificateSha256 || ''))) problems.push('invalid previous Android identity/version metadata')
    if (!stableVersion.test(mobile.version) || app.expo?.version !== mobile.version) problems.push('mobile package/app versions disagree')
    if (!Number.isSafeInteger(app.expo?.android?.versionCode) || app.expo.android.versionCode < 1) problems.push('invalid Android versionCode')
    if (android?.signingState !== 'ready' || !fingerprint.test(android?.certificateSha256 || '')) problems.push('Android signing migration is not ready')
    if (previous?.debugCertificate) problems.push('historical Android Debug identity requires a reviewed migration')
    if (previous && app.expo?.android?.package === previous.applicationId) {
      if (app.expo.android.versionCode <= previous.versionCode) problems.push('Android versionCode must increase beyond the previous release')
      if (android?.certificateSha256 !== previous.certificateSha256) problems.push('Android signing identity changed without a verified upgrade migration')
    }
    for (const name of requireSigningSecrets ? ['ANDROID_RELEASE_KEYSTORE_BASE64', 'ANDROID_RELEASE_STORE_PASSWORD', 'ANDROID_RELEASE_KEY_ALIAS', 'ANDROID_RELEASE_KEY_PASSWORD'] : []) {
      if (!env[name]) problems.push('missing ' + name)
    }
    if (problems.length) fail(problems.join('; '))
    plan.android = { version: mobile.version, versionCode: app.expo.android.versionCode, applicationId: app.expo.android.package,
      abi: android.abi, certificateSha256: android.certificateSha256, minServerProtocol: android.minServerProtocol, clientProtocol }
  }
  return plan
}
function assertJobResults(plan, results) {
  for (const name of ['plan', 'verify', 'build-windows']) check(results[name]?.result === 'success', name + ' did not succeed')
  const mobile = results['build-mobile-apk']?.result
  if (plan.mode === 'desktop-and-android') check(mobile === 'success', 'requested Android build did not succeed')
  else { check(plan.mode === 'desktop', 'unsupported release mode'); check(mobile === 'skipped', 'desktop release must have a skipped Android job') }
}
function peMachine(file) {
  const descriptor = fs.openSync(file, 'r')
  try {
    const dos = Buffer.alloc(64); check(fs.readSync(descriptor, dos, 0, dos.length, 0) === dos.length && dos.toString('ascii', 0, 2) === 'MZ', 'invalid Windows executable')
    const offset = dos.readUInt32LE(60), header = Buffer.alloc(6)
    check(offset >= 64 && offset < fs.statSync(file).size - 6, 'invalid PE header offset')
    check(fs.readSync(descriptor, header, 0, 6, offset) === 6 && header.readUInt32LE(0) === 0x00004550, 'invalid PE signature')
    const value = header.readUInt16LE(4)
    check([0x14c, 0x8664].includes(value), 'unsupported Windows bootstrap architecture')
    return value === 0x14c ? 'ia32' : 'x64'
  } finally { fs.closeSync(descriptor) }
}
function windowsVersion(file) {
  check(process.platform === 'win32', 'Windows version resources require a Windows verifier')
  const executable = process.env.WALLPAPER_RELEASE_POWERSHELL || 'pwsh.exe'
  const result = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:WALLPAPER_RELEASE_INSPECT_FILE); $s=Get-AuthenticodeSignature -LiteralPath $env:WALLPAPER_RELEASE_INSPECT_FILE; $hash=$null; if($s.SignerCertificate){$algorithm=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($algorithm.ComputeHash($s.SignerCertificate.RawData)).Replace("-", "").ToLowerInvariant()}finally{$algorithm.Dispose()}}; @{productVersion=$v.ProductVersion;fileVersion=$v.FileVersion;signatureStatus=[string]$s.Status;certificateSha256=$hash}|ConvertTo-Json -Compress'],
  { env: { ...process.env, WALLPAPER_RELEASE_INSPECT_FILE: path.resolve(file) }, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 })
  return JSON.parse(result.replace(/^\ufeff/, ''))
}
async function collectWindows({ directory, version, sourceCommit, integrity, inspectVersion = windowsVersion, signing = { required: false } }) {
  check(stableVersion.test(version), 'invalid desktop artifact version')
  const assets = []
  for (const [name, role] of [[`Wallpaper-Player-Setup-${version}.exe`, 'installer'], [`Wallpaper-Player-${version}.exe`, 'portable'],
    [`Wallpaper-Player-Setup-${version}.exe.blockmap`, 'blockmap'], ['latest.yml', 'desktop-update-metadata']]) {
    const file = artifactFile(directory, name), asset = { file: name, role, ...await hashFile(file) }
    if (role === 'installer' || role === 'portable') {
      asset.bootstrapArch = peMachine(file)
      const actual = inspectVersion(file)
      check([version, version + '.0'].includes(actual.productVersion), 'Windows product version differs from its artifact name')
      check(['Valid', 'NotSigned'].includes(actual.signatureStatus), 'Windows signature is invalid or could not be verified')
      check(actual.signatureStatus !== 'Valid' || fingerprint.test(actual.certificateSha256 || ''), 'Windows certificate digest is missing')
      if (signing.required) check(actual.signatureStatus === 'Valid' && actual.certificateSha256 === signing.certificateSha256, 'Windows signature differs from reviewed identity')
      asset.productVersion = actual.productVersion
      asset.signing = { status: actual.signatureStatus, certificateSha256: actual.certificateSha256 || null }
    }
    assets.push(asset)
  }
  const yamlFile = artifactFile(directory, 'latest.yml')
  check(fs.statSync(yamlFile).size <= 1024 * 1024, 'desktop update YAML is too large')
  const yaml = require('js-yaml').load(fs.readFileSync(yamlFile, 'utf8'), { maxTotalMergeKeys: 100 })
  const installer = assets.find(item => item.role === 'installer')
  check(yaml?.version === version && yaml.path === installer.file && yaml.sha512 === installer.sha512, 'desktop update metadata does not match the installer')
  check(Array.isArray(yaml.files) && yaml.files.length === 1 && yaml.files[0].url === installer.file && yaml.files[0].sha512 === installer.sha512 && yaml.files[0].size === installer.bytes,
    'desktop update files do not match installer hash/size')
  for (const id of ['video-analysis', 'ai-search', 'agent-bridge']) {
    const item = integrity?.packages?.[id]; check(item && stableVersion.test(item.version) && fingerprint.test(item.sha256), 'missing official plugin integrity: ' + id)
    const name = fileName(`Wallpaper-Player-Plugin-${id}-${item.version}.zip`), file = artifactFile(directory, 'plugins/' + name)
    const digest = await hashFile(file); check(digest.sha256 === item.sha256, 'plugin archive hash differs from the packaged integrity')
    const header = Buffer.alloc(4), descriptor = fs.openSync(file, 'r')
    try { fs.readSync(descriptor, header, 0, 4, 0) } finally { fs.closeSync(descriptor) }
    check(header.readUInt32LE() === 0x04034b50, 'plugin archive must be ZIP')
    assets.push({ file: name, source: 'plugins/' + name, role: 'plugin', pluginId: id, version: item.version, ...digest })
  }
  return { schemaVersion: 1, platform: 'windows', arch: 'x64', version, sourceCommit, assets }
}
function inspectAndroid(apk, { sdk, java = 'java' }) {
  const tools = path.join(sdk, 'build-tools/37.0.0')
  const signature = execFileSync(java, ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--print-certs', apk],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 })
  const badging = execFileSync(path.join(tools, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2'), ['dump', 'badging', apk],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 })
  const certificate = signature.match(/certificate SHA-256 digest: ([a-f0-9]{64})/i)?.[1]?.toLowerCase()
  const packageLine = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/)
  check(certificate && packageLine, 'incomplete verified APK metadata')
  const certificates = [...signature.matchAll(/certificate SHA-256 digest: ([a-f0-9]{64})/ig)].map(item => item[1].toLowerCase())
  check(new Set(certificates).size === 1, 'APK must have one reviewed signing identity')
  return { applicationId: packageLine[1], versionCode: Number(packageLine[2]), version: packageLine[3], certificateSha256: certificate,
    debugCertificate: /certificate DN:.*\bAndroid\s+Debug\b/i.test(signature),
    abi: [...(badging.match(/^native-code: (.*)$/m)?.[1] || '').matchAll(/'([^']+)'/g)].map(item => item[1]),
    minSdk: Number(badging.match(/minSdkVersion:'(\d+)'/)?.[1]), targetSdk: Number(badging.match(/targetSdkVersion:'(\d+)'/)?.[1]), verified: true }
}
async function collectAndroid({ apk, expected, sourceCommit, inspect = inspectAndroid, tools }) {
  check(expected.abi === 'arm64-v8a', 'unsupported Android release ABI')
  check(Number.isSafeInteger(expected.clientProtocol) && expected.clientProtocol === clientProtocol, 'Android client protocol differs from the built shared contract')
  const actual = inspect(apk, tools)
  check(actual.verified === true && actual.debugCertificate === false, 'Android release must not use a debug certificate')
  for (const key of ['applicationId', 'versionCode', 'version', 'certificateSha256']) check(actual[key] === expected[key], 'APK ' + key + ' differs from release plan')
  check(actual.abi.length === 1 && actual.abi[0] === expected.abi, 'APK ABI differs from release plan')
  check(Number.isSafeInteger(actual.minSdk) && actual.minSdk > 0 && Number.isSafeInteger(actual.targetSdk) && actual.targetSdk >= actual.minSdk, 'APK SDK metadata is invalid')
  return { schemaVersion: 1, platform: 'android', version: actual.version, sourceCommit, applicationId: actual.applicationId,
    versionCode: actual.versionCode, abi: actual.abi, minSdk: actual.minSdk, targetSdk: actual.targetSdk,
    certificateSha256: actual.certificateSha256, signatureVerified: true, debugCertificate: false, minServerProtocol: expected.minServerProtocol, clientProtocol: expected.clientProtocol,
    assets: [{ file: fileName(`wallpaper-player-mobile-${actual.version}-arm64-release.apk`), role: 'android-apk', ...await hashFile(apk) }] }
}

async function stagePart(part, sourceDirectory, outputDirectory, apk) {
  await fsp.mkdir(outputDirectory, { recursive: true })
  for (const asset of part.assets) {
    const source = part.platform === 'android' ? apk : artifactFile(sourceDirectory, asset.source || asset.file)
    await fsp.copyFile(source, path.join(outputDirectory, fileName(asset.file)), fs.constants.COPYFILE_EXCL)
    const digest = await hashFile(path.join(outputDirectory, asset.file))
    check(digest.sha256 === asset.sha256 && digest.bytes === asset.bytes, 'artifact changed while staging')
    delete asset.source
  }
  await fsp.writeFile(path.join(outputDirectory, 'part.json'), JSON.stringify(part, null, 2) + '\n', { flag: 'wx' })
}
async function assembleRelease({ plan, results, directories, sourceCommit, repository }) {
  assertJobResults(plan, results)
  check(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit || ''), 'invalid source commit')
  check(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository || ''), 'invalid repository')
  const parts = [], files = [], names = new Set()
  for (const platform of plan.mode === 'desktop-and-android' ? ['windows', 'android'] : ['windows']) {
    const directory = directories[platform], part = readJson(artifactFile(directory, 'part.json'))
    check(part.schemaVersion === 1 && part.platform === platform && part.sourceCommit === sourceCommit, 'artifact provenance differs from this run')
    check(part.version === (platform === 'windows' ? plan.desktopVersion : plan.android.version), 'artifact version differs from release plan')
    check(Array.isArray(part.assets), 'missing artifact inventory')
    if (platform === 'windows') {
      check(part.arch === 'x64' && part.assets.length === 7, 'incomplete Windows artifact inventory')
      for (const role of ['installer', 'portable', 'blockmap', 'desktop-update-metadata']) check(part.assets.filter(item => item.role === role).length === 1, 'missing Windows role: ' + role)
      for (const id of ['video-analysis', 'ai-search', 'agent-bridge']) check(part.assets.filter(item => item.role === 'plugin' && item.pluginId === id).length === 1, 'missing plugin role: ' + id)
      const requiredNames = { installer: `Wallpaper-Player-Setup-${plan.desktopVersion}.exe`, portable: `Wallpaper-Player-${plan.desktopVersion}.exe`,
        blockmap: `Wallpaper-Player-Setup-${plan.desktopVersion}.exe.blockmap`, 'desktop-update-metadata': 'latest.yml' }
      for (const item of part.assets) {
        if (item.role === 'plugin') check(stableVersion.test(item.version) && item.file === `Wallpaper-Player-Plugin-${item.pluginId}-${item.version}.zip`, 'plugin artifact name/version mismatch')
        else check(item.file === requiredNames[item.role], 'unexpected Windows artifact name')
        if (['installer', 'portable'].includes(item.role)) {
          check([plan.desktopVersion, plan.desktopVersion + '.0'].includes(item.productVersion) && ['ia32', 'x64'].includes(item.bootstrapArch), 'Windows executable metadata differs from release plan')
          check(['Valid', 'NotSigned'].includes(item.signing?.status), 'Windows artifact signing state is missing or invalid')
          check(item.signing.status === 'Valid' ? fingerprint.test(item.signing.certificateSha256 || '') : item.signing.certificateSha256 === null, 'Windows certificate metadata is inconsistent')
          if (plan.desktopSigning.required) check(item.signing.status === 'Valid' && item.signing.certificateSha256 === plan.desktopSigning.certificateSha256, 'Windows signature differs from release policy')
        }
      }
    } else {
      for (const key of ['applicationId', 'versionCode', 'certificateSha256', 'minServerProtocol', 'clientProtocol']) check(part[key] === plan.android[key], 'Android metadata differs from release plan: ' + key)
      check(Number.isSafeInteger(part.clientProtocol) && part.clientProtocol > 0, 'Android client protocol is missing')
      check(part.signatureVerified === true && part.debugCertificate === false && part.abi?.length === 1 && part.abi[0] === plan.android.abi, 'Android signature/ABI is not accepted')
      check(Number.isSafeInteger(part.minSdk) && part.minSdk > 0 && Number.isSafeInteger(part.targetSdk) && part.targetSdk >= part.minSdk, 'Android SDK metadata is inconsistent')
      check(part.assets.length === 1 && part.assets[0].role === 'android-apk', 'incomplete Android artifact inventory')
      check(part.assets[0].file === `wallpaper-player-mobile-${plan.android.version}-arm64-release.apk`, 'unexpected Android artifact name')
    }
    for (const item of part.assets) {
      const name = fileName(item.file); check(!names.has(name.toLowerCase()), 'duplicate release asset name'); names.add(name.toLowerCase())
      const file = artifactFile(directory, name), digest = await hashFile(file)
      check(digest.sha256 === item.sha256 && digest.sha512 === item.sha512 && digest.bytes === item.bytes, 'downloaded build artifact hash/size mismatch')
      files.push({ path: file, name, ...digest })
    }
    parts.push(part)
  }
  const manifest = { schemaVersion: 1, tag: plan.tag, mode: plan.mode, sourceCommit, desktopVersion: plan.desktopVersion,
    platforms: parts.map(part => part.platform === 'windows' ? { platform: part.platform, version: part.version, arch: part.arch, sourceCommit }
      : { platform: part.platform, version: part.version, applicationId: part.applicationId, versionCode: part.versionCode, abi: part.abi,
        minSdk: part.minSdk, targetSdk: part.targetSdk, minServerProtocol: part.minServerProtocol, clientProtocol: part.clientProtocol, certificateSha256: part.certificateSha256, signatureVerified: true }),
    assets: parts.flatMap(part => part.assets.map(asset => ({ file: asset.file, role: asset.role, bytes: asset.bytes, sha256: asset.sha256, sha512: asset.sha512,
      ...(asset.role === 'plugin' ? { pluginId: asset.pluginId, version: asset.version } : {}),
      ...(['installer', 'portable'].includes(asset.role) ? { bootstrapArch: asset.bootstrapArch, productVersion: asset.productVersion, signing: asset.signing } : {}),
      platform: part.platform, url: `https://github.com/${repository}/releases/download/${plan.tag}/${encodeURIComponent(asset.file)}` }))) }
  return { manifest, files }
}
function planFromEnvironment(env = process.env, { requireSigningSecrets = true } = {}) {
  check(env.GITHUB_REF_TYPE === 'tag', 'release must run from a tag')
  check(['true', 'false'].includes(env.RELEASE_INCLUDE_MOBILE), 'release mobile input must be true or false')
  return makePlan({ tag: env.GITHUB_REF_NAME, includeMobile: env.RELEASE_INCLUDE_MOBILE === 'true', desktop: readJson(path.join(root, 'package.json')),
    mobile: readJson(path.join(root, 'mobile/package.json')), app: readJson(path.join(root, 'mobile/app.json')), policy: readJson(path.join(__dirname, 'release-policy.json')), env, requireSigningSecrets })
}
async function cli() {
  const command = process.argv[2], plan = planFromEnvironment(process.env, { requireSigningSecrets: command === 'plan' })
  if (command === 'plan') {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'include-mobile=' + (plan.mode === 'desktop-and-android') + '\n')
    console.log(JSON.stringify(plan)); return
  }
  const output = process.argv[3], sourceCommit = process.env.GITHUB_SHA
  check(output, 'artifact output directory is required')
  if (command === 'windows') {
    const { directory, integrityPath } = await require('./build-output.cjs').resolveOutput(root, 'windows', { mode: 'distribution', version: plan.desktopVersion, sourceCommit })
    await require('./package-win.js').validateWindowsOutput(directory, { version: plan.desktopVersion, mode: 'distribution', sourceCommit })
    const integrity = readJson(integrityPath)
    await stagePart(await collectWindows({ directory, version: plan.desktopVersion, sourceCommit, integrity, signing: plan.desktopSigning }), directory, output)
  } else if (command === 'android') {
    check(plan.android, 'Android not requested')
    const apk = process.argv[4]; check(apk, 'signed APK is required')
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    await stagePart(await collectAndroid({ apk, expected: plan.android, sourceCommit, tools: { sdk: process.env.ANDROID_HOME, java } }), null, output, apk)
  } else fail('unknown artifact command')
  console.log(JSON.stringify({ staged: true, mode: plan.mode }))
}
if (require.main === module) cli().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { readJson, makePlan, planFromEnvironment, assertJobResults, hashFile, artifactFile, fileName, peMachine, windowsVersion,
  collectWindows, inspectAndroid, collectAndroid, stagePart, assembleRelease }
