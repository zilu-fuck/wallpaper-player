import { useState, useCallback } from 'react'

export default function Settings({ settings, ffmpegStatus, mpvStatus, onMpvStatusChange, onSave, onDirectoryChange, onClose }) {
  const [directories, setDirectories] = useState(settings?.directories || [])
  const [defaultDir, setDefaultDir] = useState(settings?.defaultDirectory || '')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)

  const handleAddDirectory = useCallback(async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir && !directories.includes(dir)) {
      const newDirs = [...directories, dir]
      setDirectories(newDirs)
      if (!defaultDir) setDefaultDir(dir)
    }
  }, [directories, defaultDir])

  const handleRemoveDirectory = useCallback((dir) => {
    const newDirs = directories.filter(d => d !== dir)
    setDirectories(newDirs)
    if (defaultDir === dir) {
      setDefaultDir(newDirs[0] || '')
    }
  }, [directories, defaultDir])

  const handleSetDefault = useCallback((dir) => {
    setDefaultDir(dir)
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    await onSave({
      directories,
      defaultDirectory: defaultDir
    })
    setSaving(false)
    onClose()
  }, [directories, defaultDir, onSave, onClose])

  const handleScanDir = useCallback((dir) => {
    onDirectoryChange(dir)
  }, [onDirectoryChange])

  const handleDownloadMpv = useCallback(async () => {
    setDownloading(true)
    setDownloadProgress(null)

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
      alert('mpv 下载失败: ' + (result.error || '未知错误'))
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

        {/* 视频目录管理 */}
        <section className="settings-section">
          <h3 className="section-title">视频目录</h3>
          <p className="section-desc">管理你的视频文件夹路径。点击目录名可切换到该目录。</p>

          <div className="dir-list">
            {directories.map((dir) => (
              <div key={dir} className={`dir-item ${dir === defaultDir ? 'default' : ''}`}>
                <div className="dir-info" onClick={() => handleScanDir(dir)} title="点击切换到此目录">
                  {dir === defaultDir && <span className="dir-badge">默认</span>}
                  <span className="dir-path" title={dir}>{dir}</span>
                </div>
                <div className="dir-actions">
                  {dir !== defaultDir && (
                    <button
                      className="btn btn-xs"
                      onClick={() => handleSetDefault(dir)}
                      title="设为默认"
                    >
                      设为默认
                    </button>
                  )}
                  <button
                    className="btn btn-xs"
                    onClick={() => handleScanDir(dir)}
                    title="扫描此目录"
                  >
                    扫描
                  </button>
                  <button
                    className="btn btn-xs btn-danger"
                    onClick={() => handleRemoveDirectory(dir)}
                    title="移除"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button className="btn btn-outline" onClick={handleAddDirectory}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            添加目录
          </button>
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
              <div style={{ flex: 1 }}>
                <p>未检测到 mpv — 将使用内置播放器（格式支持有限）</p>
                <p className="hint">
                  mpv 支持几乎所有视频格式，推荐安装以获得最佳体验。
                </p>
                <div className="mpv-actions" style={{ marginTop: 8, display: 'flex', gap: 8 }}>
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
