import legacyReleases from './legacy-mobile-releases.json'

export const RELEASE_REPOSITORY = 'zilu-fuck/wallpaper-player'
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases`
const RELEASE_WEB = `https://github.com/${RELEASE_REPOSITORY}/releases`
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const fingerprint = /^[a-f0-9]{64}$/
const fileName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/
const abis = new Set(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'])
type JsonObject = Record<string, unknown>
const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const version = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && stable.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part)))
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error('更新元数据无效：' + message) }

export type AndroidUpdateEnvironment = {
  platform: 'android'
  applicationId: string
  version: string
  versionCode: number
  supportedAbis: string[]
  sdkVersion: number
  certificateSha256: string[]
}
export type ReleaseAsset = { name: string, browser_download_url: string, size: number, digest?: string | null, state: string }
export type PublishedRelease = { tag_name: string, name: string, published_at: string, assets: ReleaseAsset[] }
export type MobileCandidate = {
  version: string, versionCode: number, applicationId: string, abi: string[], minSdk: number, targetSdk: number,
  certificateSha256: string, minServerProtocol: number, clientProtocol: number, file: string, bytes: number, sha256: string,
  url: string, tag: string, releaseName: string, publishedAt: string, metadata: 'manifest-v1' | 'pinned-legacy'
}
export function validateUpdateEnvironment(value: unknown): AndroidUpdateEnvironment {
  check(record(value) && value.platform === 'android', '缺少 Android 安装环境')
  check(typeof value.applicationId === 'string' && /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(value.applicationId), '安装包标识')
  check(version(value.version) && integer(value.versionCode) && integer(value.sdkVersion), '安装版本或系统版本')
  check(Array.isArray(value.supportedAbis) && value.supportedAbis.length > 0 && value.supportedAbis.length <= 8 && value.supportedAbis.every(abi => typeof abi === 'string' && abis.has(abi)), '设备 ABI')
  check(Array.isArray(value.certificateSha256) && value.certificateSha256.length === 1 && typeof value.certificateSha256[0] === 'string' && fingerprint.test(value.certificateSha256[0]), '安装签名；多签名或未知身份需人工核对')
  return value as AndroidUpdateEnvironment
}
export function compareVersions(left: string, right: string) {
  check(version(left) && version(right), '手机版本')
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}
export const releasePageUrl = (tag: string) => `${RELEASE_WEB}/tag/${tag}`
export const releaseAssetUrl = (tag: string, name: string) => `${RELEASE_WEB}/download/${tag}/${encodeURIComponent(name)}`
export function parseReleaseList(value: unknown): PublishedRelease[] {
  check(Array.isArray(value) && value.length <= 20, '发布列表')
  const releases: PublishedRelease[] = []
  for (const item of value) {
    check(record(item) && typeof item.draft === 'boolean' && typeof item.prerelease === 'boolean', '发布状态')
    if (item.draft || item.prerelease) continue
    check(typeof item.tag_name === 'string' && item.tag_name.startsWith('v') && version(item.tag_name.slice(1)), '发布标签')
    check(typeof item.published_at === 'string' && Number.isFinite(Date.parse(item.published_at)), '发布时间')
    check(Array.isArray(item.assets) && item.assets.length <= 128, '发布资产列表')
    const assets: ReleaseAsset[] = [], names = new Set<string>()
    for (const asset of item.assets) {
      check(record(asset) && typeof asset.name === 'string', '资产名称')
      if (asset.name !== 'release-manifest.json' && !/\.(?:apk|ipa)$/i.test(asset.name)) continue
      check(fileName.test(asset.name) && !asset.name.endsWith('.'), '资产名称')
      check(!names.has(asset.name.toLowerCase()), '重复资产名称'); names.add(asset.name.toLowerCase())
      check(asset.browser_download_url === releaseAssetUrl(item.tag_name, asset.name) && integer(asset.size) && asset.state === 'uploaded', '资产路径、大小或上传状态')
      check(asset.digest === undefined || asset.digest === null || typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(asset.digest), '资产摘要')
      assets.push(asset as ReleaseAsset)
    }
    releases.push({ tag_name: item.tag_name, name: typeof item.name === 'string' ? item.name.slice(0, 200) : '', published_at: item.published_at, assets })
  }
  return releases
}
function bindCandidate(release: PublishedRelease, value: JsonObject, source: MobileCandidate['metadata']): MobileCandidate {
  check(version(value.version) && integer(value.versionCode), 'Android 版本')
  check(typeof value.applicationId === 'string' && /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(value.applicationId), 'Android 应用标识')
  check(Array.isArray(value.abi) && value.abi.length > 0 && value.abi.length <= 4 && new Set(value.abi).size === value.abi.length && value.abi.every(abi => typeof abi === 'string' && abis.has(abi)), 'APK ABI')
  check(integer(value.minSdk) && integer(value.targetSdk) && value.targetSdk >= value.minSdk && integer(value.minServerProtocol), 'APK 系统或协议要求')
  const clientProtocol = value.clientProtocol === undefined ? 1 : value.clientProtocol
  check(integer(clientProtocol), '手机客户端协议')
  check(typeof value.certificateSha256 === 'string' && fingerprint.test(value.certificateSha256), 'APK 签名摘要')
  check(typeof value.file === 'string' && fileName.test(value.file) && integer(value.bytes) && typeof value.sha256 === 'string' && fingerprint.test(value.sha256), 'APK 文件摘要')
  const suffix = value.abi.length > 1 ? 'universal' : ({ 'arm64-v8a': 'arm64', 'armeabi-v7a': 'armeabi-v7a', x86: 'x86', x86_64: 'x86_64' } as Record<string, string>)[String(value.abi[0])]
  check(value.file === `wallpaper-player-mobile-${value.version}-${suffix}-release.apk`, 'APK 文件与版本/ABI不符')
  const asset = release.assets.find(item => item.name === value.file)
  check(asset && asset.size === value.bytes && (!asset.digest || asset.digest === 'sha256:' + value.sha256), '清单与发布资产不符')
  check(value.url === undefined || value.url === asset.browser_download_url, '清单下载地址')
  return { version: value.version, versionCode: value.versionCode, applicationId: value.applicationId, abi: value.abi as string[], minSdk: value.minSdk,
    targetSdk: value.targetSdk, certificateSha256: value.certificateSha256, minServerProtocol: value.minServerProtocol, clientProtocol,
    file: value.file, bytes: value.bytes, sha256: value.sha256, url: asset.browser_download_url, tag: release.tag_name,
    releaseName: release.name || `Wallpaper Player Mobile ${value.version}`, publishedAt: release.published_at, metadata: source }
}
export function parseManifest(release: PublishedRelease, manifest: unknown): MobileCandidate | null {
  check(record(manifest) && manifest.schemaVersion === 1 && manifest.tag === release.tag_name, '清单版本或标签')
  check(version(manifest.desktopVersion) && manifest.tag === 'v' + manifest.desktopVersion && typeof manifest.sourceCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceCommit), '清单来源')
  check(Array.isArray(manifest.platforms) && manifest.platforms.length <= 4 && manifest.platforms.every(record) && Array.isArray(manifest.assets) && manifest.assets.length <= 32 && manifest.assets.every(record), '清单平台或资产')
  const android = manifest.platforms.filter(item => item.platform === 'android'), apks = manifest.assets.filter(item => item.role === 'android-apk' || item.platform === 'android')
  if (manifest.mode === 'desktop') { check(android.length === 0 && apks.length === 0 && !release.assets.some(item => item.name.endsWith('.apk')), '桌面发布包含未声明APK'); return null }
  check(manifest.mode === 'desktop-and-android' && android.length === 1 && apks.length === 1, '联合发布Android清单不完整')
  const platform = android[0], asset = apks[0]
  check((platform.sourceCommit === undefined || platform.sourceCommit === manifest.sourceCommit) && platform.signatureVerified === true && platform.debugCertificate !== true && asset.platform === 'android' && asset.role === 'android-apk', 'Android 来源或签名验证状态')
  return bindCandidate(release, { ...asset, ...platform, file: asset.file, bytes: asset.bytes, sha256: asset.sha256, url: asset.url }, 'manifest-v1')
}
export function findPinnedLegacy(release: PublishedRelease): MobileCandidate | null {
  const known = legacyReleases.find(item => item.tag === release.tag_name)
  if (!known) return null
  check(release.assets.find(item => item.name === known.file)?.digest === 'sha256:' + known.sha256, '历史APK摘要与固定基线不符')
  return bindCandidate(release, known, 'pinned-legacy')
}
export function compatible(candidate: MobileCandidate, environment: AndroidUpdateEnvironment, serverProtocol: number, minClientProtocol = 1): boolean {
  return candidate.applicationId === environment.applicationId && candidate.certificateSha256 === environment.certificateSha256[0] &&
    candidate.abi.some(abi => environment.supportedAbis.includes(abi)) && candidate.minSdk <= environment.sdkVersion && candidate.minServerProtocol <= serverProtocol && candidate.clientProtocol >= minClientProtocol
}
export function chooseCandidate(candidates: MobileCandidate[], environment: AndroidUpdateEnvironment): MobileCandidate | null {
  const sorted = [...candidates].sort((a, b) => b.versionCode - a.versionCode || compareVersions(b.version, a.version) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  const selected = sorted[0]
  if (!selected) return null
  const order = compareVersions(selected.version, environment.version)
  check(!(order > 0 && selected.versionCode <= environment.versionCode || order < 0 && selected.versionCode > environment.versionCode), '版本名与递增版本码冲突')
  const sameCode = sorted.filter(item => item.versionCode === selected.versionCode)
  check(sameCode.every(item => item.sha256 === selected.sha256 && item.version === selected.version), '相同版本码存在不同安装包')
  return selected
}
