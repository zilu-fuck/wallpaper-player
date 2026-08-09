export function UpdateSection({ onCheckUpdate }) {
  return (
    <section className="settings-section">
      <h3 className="section-title">应用更新</h3>
      <p className="section-desc">检查 GitHub Releases 上是否有新版本。</p>
      <div className="ffmpeg-status">
        <span className="status-dot green" />
        <div className="status-content">
          <p>安装版会在后台定期检查更新，也可以手动检查。</p>
          <p className="hint">便携版不支持自动更新，需要手动下载新版。</p>
          <div className="mpv-actions">
            <button className="btn btn-sm btn-primary" onClick={onCheckUpdate} type="button">
              检查更新
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function MpvStatusSection({
  mpvStatus,
  downloading,
  downloadProgress,
  mpvDownloadError,
  onDownloadMpv,
  onSelectMpvPath
}) {
  return (
    <section className="settings-section">
      <h3 className="section-title">mpv 播放器</h3>
      {mpvStatus?.available ? (
        <div className="ffmpeg-status ok">
          <span className="status-dot green" />
          <div>
            <span>已检测到 mpv — 播放功能正常</span>
            <p className="hint" style={{ marginTop: 4 }}>
              路径: {mpvStatus.path}
              {mpvStatus.version && <><br />{mpvStatus.version}</>}
            </p>
          </div>
        </div>
      ) : (
        <div className="ffmpeg-status warn">
          <span className="status-dot yellow" />
          <div className="status-content">
            <p>未检测到标准 mpv — 将使用内置 HTML5 播放器（格式支持有限）</p>
            <p className="hint">
              mpv 支持几乎所有视频格式，推荐安装以获得最佳体验。
            </p>
            <div className="mpv-actions">
              <button
                className="btn btn-sm btn-primary"
                onClick={onDownloadMpv}
                disabled={downloading}
                type="button"
              >
                {downloading
                  ? `下载中... ${downloadProgress ? downloadProgress.percent + '%' : ''}`
                  : '自动下载 mpv'
                }
              </button>
              <button
                className="btn btn-sm"
                onClick={onSelectMpvPath}
                type="button"
              >
                手动选择 mpv.exe
              </button>
            </div>
            {mpvDownloadError && (
              <p className="hint error">mpv 下载失败: {mpvDownloadError}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export function FfmpegStatusSection({ ffmpegStatus }) {
  return (
    <section className="settings-section">
      <h3 className="section-title">FFmpeg 状态</h3>
      {ffmpegStatus?.available ? (
        <div className="ffmpeg-status ok">
          <span className="status-dot green" />
          <span>已检测到 FFmpeg — 缩略图功能正常</span>
        </div>
      ) : (
        <div className="ffmpeg-status warn">
          <span className="status-dot yellow" />
          <div>
            <p>未检测到 FFmpeg — 将无法生成视频缩略图</p>
            <p className="hint">
              请安装 FFmpeg 并确保其在系统 PATH 中。
              可从 <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener">ffmpeg.org</a> 下载。
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

function getDownloadPortLabel(engine) {
  const status = engine?.btPortStatus
  if (!status) return '检测中'
  if (status.ports?.some(port => port.listening)) return `${status.usablePort || status.range} 已监听`
  return status.available ? `${status.usablePort} 可用` : '需检查'
}

function getProxyLabel(proxy) {
  if (!proxy?.enabled) return '未启用'
  if (proxy.source === 'windows') return '跟随系统代理'
  if (proxy.source === 'environment') return '跟随环境变量'
  return '已启用'
}

export function DownloadStatusSection({
  downloadState,
  downloadLoading,
  downloadMessage,
  onRefreshDownloadState,
  onOpenDownloadCenter
}) {
  const engine = downloadState?.engine
  const xunlei = engine?.xunlei
  const ytdlp = engine?.ytdlp
  const ok = Boolean(engine?.available)

  return (
    <section className="settings-section">
      <h3 className="section-title">下载中心</h3>
      <p className="section-desc">查看 aria2 下载引擎、BT 找源能力和迅雷接管状态。</p>
      <div className={`ffmpeg-status ${ok ? 'ok' : 'warn'}`}>
        <span className={`status-dot ${ok ? 'green' : 'yellow'}`} />
        <div className="status-content">
          <p>{ok ? (engine.running ? 'aria2 正在运行' : 'aria2 已就绪') : '未检测到 aria2c'}</p>
          <p className="hint">
            {ok
              ? `路径: ${engine.path || '内置 aria2c'}`
              : (engine?.error || '请重新执行 npm run prepare-vendor，或将 aria2c 加入 PATH。')}
          </p>
          <div className="download-settings-grid">
            <div>
              <span>BT 端口</span>
              <strong>{getDownloadPortLabel(engine)}</strong>
            </div>
            <div>
              <span>找源能力</span>
              <strong>{engine?.trackerCount || 0} tracker · DHT/PEX/LSD</strong>
            </div>
            <div>
              <span>迅雷接管</span>
              <strong>{xunlei?.available ? '已检测到' : '未检测到'}</strong>
            </div>
            <div>
              <span>网页解析</span>
              <strong>{ytdlp?.available ? 'yt-dlp 已就绪' : 'yt-dlp 未检测到'}</strong>
            </div>
            <div>
              <span>代理</span>
              <strong>{getProxyLabel(ytdlp?.proxy)}</strong>
            </div>
          </div>
          <div className="mpv-actions">
            <button className="btn btn-sm btn-primary" type="button" onClick={onOpenDownloadCenter}>
              打开下载中心
            </button>
            <button className="btn btn-sm" type="button" onClick={onRefreshDownloadState} disabled={downloadLoading}>
              {downloadLoading ? '刷新中...' : '刷新状态'}
            </button>
          </div>
          {downloadMessage ? <p className="hint">{downloadMessage}</p> : null}
        </div>
      </div>
    </section>
  )
}

export function AboutSection({ appVersion = '' }) {
  return (
    <section className="settings-section about-section">
      <div className="about-brand">
        <div className="about-brand-logo" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="2.5" y="4" width="19" height="13" rx="3" />
            <path d="M2.5 12h19" />
            <circle cx="5.5" cy="8.5" r="0.9" fill="currentColor" />
            <circle cx="5.5" cy="12.5" r="0.9" fill="currentColor" />
            <path d="M10 17l-1.5 3.5M14 17l1.5 3.5M8 20.5h8" />
            <circle cx="17.5" cy="16" r="3.2" />
            <path d="M17.5 14.5v3M15.8 16h3.4" />
          </svg>
        </div>
        <div className="about-brand-copy">
          <div className="about-brand-name">
            <strong>Wallpaper Player</strong>
            {appVersion ? <span className="about-version-badge">v{appVersion}</span> : null}
          </div>
          <span className="about-brand-tagline">本地视频画廊播放器 · 局域网随身看</span>
        </div>
      </div>

      <div className="about-grid">
        <div className="about-grid-item">
          <span>许可证</span>
          <strong>Apache-2.0</strong>
        </div>
        <div className="about-grid-item">
          <span>平台</span>
          <strong>Windows</strong>
        </div>
        <div className="about-grid-item">
          <span>渲染</span>
          <strong>Electron 35 · React 19</strong>
        </div>
        <div className="about-grid-item">
          <span>播放内核</span>
          <strong>mpv · FFmpeg</strong>
        </div>
      </div>

      <div className="about-tech-chips">
        <span>mpv</span>
        <span>FFmpeg</span>
        <span>aria2</span>
        <span>yt-dlp</span>
        <span>Vite</span>
      </div>

      <div className="about-links">
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText('https://github.com/zilu-fuck/wallpaper-player').catch(() => {})
          }}
          title="复制 GitHub 仓库地址"
        >
          GitHub 仓库
        </button>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText('https://github.com/zilu-fuck/wallpaper-player/releases').catch(() => {})
          }}
          title="复制更新发布页地址"
        >
          更新说明
        </button>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText('https://github.com/zilu-fuck/wallpaper-player/blob/master/THIRD_PARTY_NOTICES.md').catch(() => {})
          }}
          title="复制第三方声明地址"
        >
          第三方声明
        </button>
      </div>
    </section>
  )
}

export function ShortcutsSection() {
  return (
    <section className="settings-section">
      <h3 className="section-title">快捷键</h3>
      <div className="shortcut-list">
        <div className="shortcut-item">
          <kbd>Space</kbd>
          <span>播放 / 暂停</span>
        </div>
        <div className="shortcut-item">
          <kbd>Esc</kbd>
          <span>关闭播放器</span>
        </div>
        <div className="shortcut-item">
          <kbd>F</kbd>
          <span>全屏切换</span>
        </div>
        <div className="shortcut-item">
          <kbd>右键</kbd>
          <span>在文件管理器中显示</span>
        </div>
      </div>
    </section>
  )
}
