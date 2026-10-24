const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const gate = require('./release-gate.cjs')

function signApk({ apk, output, encodedKeystore, alias, tools, temporaryRoot, env = process.env, exec = execFileSync }) {
  if (typeof encodedKeystore !== 'string' || !encodedKeystore.length || encodedKeystore.length > 24 * 1024 * 1024) throw Error('Release gate: invalid encoded signing keystore')
  const bytes = Buffer.from(encodedKeystore, 'base64')
  let keyFile
  try {
    if (!bytes.length || bytes.toString('base64') !== encodedKeystore || !alias || fs.existsSync(output)) throw Error('Release gate: invalid signing input or existing output')
    const temporaryDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'wallpaper-release-key-'))
    keyFile = path.join(temporaryDirectory, 'release.keystore')
    fs.writeFileSync(keyFile, bytes, { flag: 'wx', mode: 0o600 })
    const jar = path.join(tools.sdk, 'build-tools/37.0.0/lib/apksigner.jar')
    exec(tools.java, ['-jar', jar, 'sign', '--ks', keyFile, '--ks-key-alias', alias,
      '--ks-pass', 'env:ANDROID_RELEASE_STORE_PASSWORD', '--key-pass', 'env:ANDROID_RELEASE_KEY_PASSWORD', '--out', output, apk],
    { env, windowsHide: true, stdio: 'pipe', timeout: 120000, maxBuffer: 128 * 1024 })
  } finally {
    bytes.fill(0)
    if (keyFile && fs.existsSync(keyFile)) fs.unlinkSync(keyFile)
  }
  return gate.inspectAndroid(output, tools)
}

if (require.main === module) {
  try {
    const plan = gate.planFromEnvironment(); if (!plan.android) throw Error('Release gate: Android not requested')
    const output = path.resolve('.release/signed/app-release.apk'); fs.mkdirSync(path.dirname(output), { recursive: true })
    const tools = { sdk: process.env.ANDROID_HOME, java: path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') }
    const metadata = signApk({ apk: path.resolve('mobile/android/app/build/outputs/apk/release/app-release.apk'), output,
      encodedKeystore: process.env.ANDROID_RELEASE_KEYSTORE_BASE64, alias: process.env.ANDROID_RELEASE_KEY_ALIAS, temporaryRoot: process.env.RUNNER_TEMP, tools })
    if (metadata.debugCertificate || metadata.certificateSha256 !== plan.android.certificateSha256) throw Error('Release gate: signed APK identity differs from release plan')
    console.log(JSON.stringify({ signed: true, certificateSha256: metadata.certificateSha256 }))
  } catch (error) {
    // Native signing errors can contain command arguments; keep credentials out of logs.
    console.error(error.message.startsWith('Release gate:') ? error.message : 'Release gate: native signing failed; check the signing configuration')
    process.exitCode = 1
  }
}
module.exports = { signApk }
