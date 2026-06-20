const LATEST_RELEASE_URL = 'https://api.github.com/repos/zilu-fuck/wallpaper-player/releases/latest'

export type MobileUpdateInfo = {
  available: boolean
  currentVersion: string
  latestVersion: string
  releaseName: string
  releaseUrl: string
  downloadUrl: string
  publishedAt: string
}

type GitHubReleaseAsset = {
  name?: string
  browser_download_url?: string
}

type GitHubRelease = {
  tag_name?: string
  name?: string
  html_url?: string
  published_at?: string
  assets?: GitHubReleaseAsset[]
}

function cleanVersion(version: string) {
  return String(version || '').trim().replace(/^v/i, '')
}

function compareVersions(left: string, right: string) {
  const leftParts = cleanVersion(left).split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const rightParts = cleanVersion(right).split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }

  return 0
}

function findMobileDownloadUrl(release: GitHubRelease) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const mobileAsset = assets.find(asset => /\.(apk|ipa)$/i.test(asset.name || ''))
  return mobileAsset?.browser_download_url || ''
}

export async function checkMobileUpdate(currentVersion: string): Promise<MobileUpdateInfo> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json'
    }
  })

  if (!response.ok) {
    throw new Error(`检查更新失败: ${response.status}`)
  }

  const release = await response.json() as GitHubRelease
  const latestVersion = cleanVersion(release.tag_name || '')
  if (!latestVersion) {
    throw new Error('没有找到最新版本号')
  }

  return {
    available: compareVersions(latestVersion, currentVersion) > 0,
    currentVersion,
    latestVersion,
    releaseName: release.name || `Wallpaper Player ${latestVersion}`,
    releaseUrl: release.html_url || `https://github.com/zilu-fuck/wallpaper-player/releases/tag/v${latestVersion}`,
    downloadUrl: findMobileDownloadUrl(release),
    publishedAt: release.published_at || ''
  }
}
