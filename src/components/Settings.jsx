import { useState, useCallback, useEffect } from 'react'

export default function Settings({ settings, ffmpegStatus, mpvStatus, onMpvStatusChange, onSave, onThemeChange, onCheckUpdate, onClose }) {
  const [theme, setTheme] = useState(settings?.theme || 'dark')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [mpvDownloadError, setMpvDownloadError] = useState('')

  useEffect(() => {
    setTheme(settings?.theme || 'dark')
  }, [settings])

  const handleChangeTheme = useCallback(async (nextTheme) => {
    setTheme(nextTheme)
    await onThemeChange(nextTheme)
  }, [onThemeChange])

  const handleSave = useCallback(async () => {
    setSaving(true)
    await onSave({ theme })
    setSaving(false)
    onClose()
  }, [theme, onSave, onClose])

  const handleDownloadMpv = useCallback(async () => {
    setDownloading(true)
    setDownloadProgress(null)
    setMpvDownloadError('')

    const removeListener = window.electronAPI.onMpvDownloadProgress((progress) => {
      setDownloadProgress(progress)
    })

    const result = await window.electronAPI.downloadMpv()
    removeListener?.()
    setDownloading(false)

    if (result.success) {
      const status = await window.electronAPI.checkMpv()
      onMpvStatusChange(status)
    } else {
      setMpvDownloadError(result.error || '未知错误')
    }
  }, [onMpvStatusChange])

  const handleSelectMpvPath = useCallback(async () => {
    const mpvPath = await window.electronAPI.selectMpvPath()
    if (mpvPath) {
      const newSettings = { ...settings, mpvPath }
      await onSave(newSettings)
      const status = await window.electronAPI.checkMpv()
      onMpvStatusChange(status)
    }
  }, [settings, onSave, onMpvStatusChange])

  return (
    <div className="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-panel">
        {/* 标题栏 */}
        <div className="settings-header">
          <h2>设置</h2>
          <button className="btn btn-icon" onClick={onClose} title="关闭">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="section-title">外观</h3>
            <p className="section-desc">切换深色或亮色主题。</p>
            <div className="theme-toggle" role="group" aria-label="主题切换">
              <button
                className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => handleChangeTheme('dark')}
                type="button"
              >
                <span className="theme-swatch dark" />
                深色
              </button>
              <button
                className={`theme-option ${theme === 'light' ? 'active' : ''}`}
                onClick={() => handleChangeTheme('light')}
                type="button"
              >
                <span className="theme-swatch light" />
                亮色
              </button>
            </div>
          </section>

          {/* 应用更新 */}
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

          {/* mpv 播放器 */}
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
                      onClick={handleDownloadMpv}
                      disabled={downloading}
                    >
                      {downloading
                        ? `下载中... ${downloadProgress ? downloadProgress.percent + '%' : ''}`
                        : '自动下载 mpv'
                      }
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={handleSelectMpvPath}
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

          {/* FFmpeg 状态 */}
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

          {/* 快捷键说明 */}
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
        </div>

        {/* 操作按钮 */}
        <div className="settings-footer">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
