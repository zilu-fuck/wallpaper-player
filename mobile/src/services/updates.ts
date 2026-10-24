import { fetch as expoFetch } from 'expo/fetch'
import { readUpdateEnvironment } from './update-environment'
import { acquireUpdateServerContext, type UpdateServerLease } from './update-server-context'
import { RELEASE_API, chooseCandidate, compareVersions, compatible, findPinnedLegacy, parseManifest, parseReleaseList,
  releaseAssetUrl, releasePageUrl, validateUpdateEnvironment, type AndroidUpdateEnvironment, type MobileCandidate } from './update-manifest'

const UPDATE_FETCH_TIMEOUT_MS = 15000
const MAX_PAGES = 5
const PAGE_SIZE = 20
const MAX_MANIFESTS = 20
const MAX_LIST_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024

export type MobileUpdateInfo = {
  available: boolean, currentVersion: string, latestVersion: string, releaseName: string, releaseUrl: string,
  downloadUrl: string, publishedAt: string,
  versionCode: number, applicationId: string, abi: string[], minServerProtocol: number,
  certificateSha256: string, sha256: string, bytes: number, metadata: 'manifest-v1' | 'pinned-legacy',
  serverProtocol: number, serverMinClientProtocol: number, clientProtocol: number, serverContext: 'global' | 'provided' | 'device', serverDeviceId?: string
}
export type UpdateCheckOptions = { signal?: AbortSignal, serverProtocol?: number, serverMinClientProtocol?: number }
type FetchResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'body'>
type Fetch = (url: string, init: RequestInit) => Promise<FetchResponse>
type Dependencies = { fetch: Fetch, environment: () => Promise<AndroidUpdateEnvironment>, timeoutMs?: number }
const cancelled = () => Object.assign(new Error('检查更新已取消'), { name: 'AbortError' })
function assertActive(signal: AbortSignal) { if (signal.aborted) throw cancelled() }

async function readJson(fetch: Fetch, url: string, limit: number, signal: AbortSignal) {
  assertActive(signal)
  const response = await fetch(url, { headers: { Accept: url.startsWith(RELEASE_API) ? 'application/vnd.github+json' : 'application/json',
    'X-GitHub-Api-Version': '2026-03-10' }, signal, credentials: 'omit' })
  if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw cancelled() }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`检查更新失败: ${response.status}`) }
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {}); throw new Error('更新元数据超过大小上限')
  }
  if (!response.body) throw new Error('当前网络模块不支持有界更新检查，请重新安装应用')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelReader, { once: true })
  if (signal.aborted) cancelReader()
  let size = 0, finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read(); assertActive(signal)
      if (done) { finished = true; break }
      size += value.byteLength
      if (size > limit) throw new Error('更新元数据超过大小上限')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } finally {
    signal.removeEventListener('abort', cancelReader)
    if (!finished) void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* A timed-out native read can still be settling. */ }
  }
}

export function createMobileUpdateChecker(dependencies: Dependencies) {
  return async function check(_currentVersion: string, options: UpdateCheckOptions = {}): Promise<MobileUpdateInfo> {
    const controller = new AbortController(), timeoutMs = dependencies.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > UPDATE_FETCH_TIMEOUT_MS) throw new Error('无效的更新检查时限')
    if (options.serverProtocol !== undefined && (!Number.isSafeInteger(options.serverProtocol) || options.serverProtocol < 1)) throw new Error('无效的电脑协议版本')
    if (options.serverMinClientProtocol !== undefined && (!Number.isSafeInteger(options.serverMinClientProtocol) || options.serverMinClientProtocol < 1)) throw new Error('无效的电脑最低客户端协议')
    let rejectStopped: (reason: Error) => void = () => {}
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
    const abort = () => { rejectStopped(cancelled()); controller.abort() }
    const timer = setTimeout(() => { rejectStopped(new Error('检查更新超时，请稍后再试')); controller.abort() }, timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    let lease: UpdateServerLease | undefined
    async function run(): Promise<MobileUpdateInfo> {
      assertActive(controller.signal)
      // PackageManager is authoritative: JS/config versions and guessed ABIs cannot identify an installed APK.
      const environment = validateUpdateEnvironment(await dependencies.environment()); assertActive(controller.signal)
      const context = await lease!.resolve(); assertActive(controller.signal)
      if (context.source === 'device' && options.serverProtocol !== undefined && options.serverProtocol !== context.serverProtocol) throw new Error('提供的协议版本与当前电脑不一致，请重新检查')
      if (context.source === 'device' && options.serverMinClientProtocol !== undefined && options.serverMinClientProtocol !== context.minClientProtocol) throw new Error('提供的最低客户端协议与当前电脑不一致，请重新检查')
      const serverProtocol = context.source === 'device' ? context.serverProtocol : options.serverProtocol ?? context.serverProtocol
      const serverMinClientProtocol = context.source === 'device' ? context.minClientProtocol : options.serverMinClientProtocol ?? context.minClientProtocol
      const candidates: MobileCandidate[] = [], failures: Error[] = [], seen = new Set<string>()
      let complete = false, manifests = 0, incompatible = false, incompatibleUpgrade = false
      for (let page = 1; page <= MAX_PAGES; page++) {
        const value = await readJson(dependencies.fetch, `${RELEASE_API}?per_page=${PAGE_SIZE}&page=${page}`, MAX_LIST_BYTES, controller.signal)
        const releases = parseReleaseList(value)
        for (const release of releases) {
          if (seen.has(release.tag_name)) continue
          seen.add(release.tag_name)
          if (!release.assets.some(asset => asset.name.endsWith('.apk'))) continue
          try {
            const manifestAsset = release.assets.find(asset => asset.name === 'release-manifest.json')
            let candidate: MobileCandidate | null
            if (manifestAsset) {
              if (++manifests > MAX_MANIFESTS) throw new Error('手机发布过多，无法在单次检查中确认最新兼容版本，请查看发布页')
              candidate = parseManifest(release, await readJson(dependencies.fetch, releaseAssetUrl(release.tag_name, 'release-manifest.json'), MAX_MANIFEST_BYTES, controller.signal))
            } else {
              candidate = findPinnedLegacy(release)
              if (!candidate && release.assets.some(asset => {
                const found = asset.name.match(/^wallpaper-player-mobile-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-[A-Za-z0-9_-]+-release\.apk$/)
                return found && compareVersions(found[1], environment.version) > 0
              })) throw new Error('较新的手机安装包缺少可验证清单，请先核对发布信息')
            }
            if (candidate && compatible(candidate, environment, serverProtocol, serverMinClientProtocol)) candidates.push(candidate)
            else {
              incompatible = true
              if (candidate && candidate.versionCode > environment.versionCode && compareVersions(candidate.version, environment.version) >= 0) incompatibleUpgrade = true
            }
          } catch (error) {
            assertActive(controller.signal)
            failures.push(error instanceof Error ? error : new Error('无法读取手机发布清单'))
          }
        }
        assertActive(controller.signal)
        if (Array.isArray(value) && value.length < PAGE_SIZE) { complete = true; break }
      }
      if (!complete || manifests > MAX_MANIFESTS) throw new Error('发布列表超出检查范围，无法确认最新兼容版本，请查看发布页')
      // Do not report an older result as latest when a relevant manifest or its transfer was invalid.
      if (failures.length) throw failures[0]
      const selected = chooseCandidate(candidates, environment)
      if (!selected) throw new Error(incompatible
        ? '未找到与当前安装包、设备ABI、系统及电脑协议兼容的更新；签名或应用标识迁移需另行处理'
        : '尚未找到带有可验证手机元数据的正式发布')
      const available = selected.versionCode > environment.versionCode && compareVersions(selected.version, environment.version) >= 0
      if (!available && incompatibleUpgrade) throw new Error('较新的手机发布与当前安装身份、设备或电脑协议不兼容，请先核对迁移要求')
      await lease!.validate(); assertActive(controller.signal)
      return { available, currentVersion: environment.version, latestVersion: selected.version, releaseName: selected.releaseName,
        releaseUrl: releasePageUrl(selected.tag), downloadUrl: available ? selected.url : '', publishedAt: selected.publishedAt,
        versionCode: selected.versionCode, applicationId: selected.applicationId, abi: selected.abi, minServerProtocol: selected.minServerProtocol,
        certificateSha256: selected.certificateSha256, sha256: selected.sha256, bytes: selected.bytes, metadata: selected.metadata,
        serverProtocol, serverMinClientProtocol, clientProtocol: selected.clientProtocol,
        serverContext: context.source === 'device' ? 'device' : options.serverProtocol === undefined && options.serverMinClientProtocol === undefined ? 'global' : 'provided', serverDeviceId: context.deviceId }
    }
    try {
      let work: Promise<MobileUpdateInfo>
      try {
        lease = acquireUpdateServerContext(controller.signal, () => { rejectStopped(new Error('当前电脑、导航或绑定已变化，请重新检查更新')); controller.abort() })
        work = run()
      } catch (error) { work = Promise.reject(error) }
      return await Promise.race([work, stopped])
    } finally { lease?.dispose(); clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort() }
  }
}

// The UI call shape is retained while selection uses the actual installed version.
export const checkMobileUpdate = createMobileUpdateChecker({ fetch: expoFetch, environment: readUpdateEnvironment })
