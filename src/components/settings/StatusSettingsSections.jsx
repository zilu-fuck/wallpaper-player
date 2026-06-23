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

export function AboutSection() {
  return (
    <section className="settings-section">
      <h3 className="section-title">About</h3>
      <div className="about-info">
        <span>Wallpaper Player</span>
        <span>License: Apache-2.0</span>
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
