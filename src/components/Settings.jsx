import { useState, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext'

export default function Settings() {
  const {
    settings,
    ffmpegStatus,
    mpvStatus,
    setMpvStatus,
    saveSettings,
    handleThemeChange,
    playbackMode,
    handlePlaybackModeChange,
    handleCheckUpdate,
    setShowSettings
  } = useApp()

  const [theme, setTheme] = useState(settings?.theme || 'dark')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const [mpvDownloadError, setMpvDownloadError] = useState('')
  const [remoteState, setRemoteState] = useState(null)
  const [remoteSaving, setRemoteSaving] = useState(false)
  const [remotePort, setRemotePort] = useState(String(settings?.remoteAccess?.port || 38127))
  const [remoteCopied, setRemoteCopied] = useState('')
  const [pairingCode, setPairingCode] = useState(null)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [pairingTick, setPairingTick] = useState(Date.now())
  const [appVersion, setAppVersion] = useState('')
  const onClose = useCallback(() => setShowSettings(false), [setShowSettings])
  const windowCloseMode = settings?.windowClose?.mode || 'ask'
  const closeWithoutPrompt = windowCloseMode !== 'ask'

  useEffect(() => {
    setTheme(settings?.theme || 'dark')
    setRemotePort(String(settings?.remoteAccess?.port || 38127))
  }, [settings])

  useEffect(() => {
    let mounted = true
    window.electronAPI.getAppVersion?.().then((version) => {
      if (mounted) setAppVersion(version || '')
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    let mounted = true
    window.electronAPI.remoteGetState?.().then((state) => {
      if (mounted) setRemoteState(state)
    })
    const cleanup = window.electronAPI.onRemoteAccessState?.((state) => {
      setRemoteState(state)
      setRemotePort(String(state?.settings?.port || 38127))
    })
    return () => {
      mounted = false
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    if (!pairingCode) return undefined
    const timer = setInterval(() => {
      setPairingTick(Date.now())
      window.electronAPI.remoteGetState?.().then(setRemoteState)
    }, 1000)
    return () => clearInterval(timer)
  }, [pairingCode])

  const handleChangeTheme = useCallback(async (nextTheme) => {
    setTheme(nextTheme)
    await handleThemeChange(nextTheme)
  }, [handleThemeChange])

  const handleSave = useCallback(async () => {
    setSaving(true)
    await saveSettings({ theme })
    setSaving(false)
    onClose()
  }, [theme, saveSettings, onClose])

  const handleWindowCloseModeChange = useCallback(async (mode) => {
    await saveSettings({
      windowClose: {
        ...(settings?.windowClose || {}),
        mode,
        rememberedAction: '',
        rememberedDate: ''
      }
    })
  }, [settings, saveSettings])

  const handleRemoteSave = useCallback(async (patch = {}) => {
    const current = remoteState?.settings || settings?.remoteAccess || {}
    const port = Number(remotePort)
    const next = {
      enabled: Boolean(current.enabled),
      keepRunningInTray: current.keepRunningInTray == null ? true : Boolean(current.keepRunningInTray),
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 38127,
      ...patch
    }

    setRemoteSaving(true)
    const state = await window.electronAPI.remoteSaveSettings(next)
    setRemoteState(state)
    await saveSettings({ remoteAccess: state.settings })
    setRemoteSaving(false)
  }, [remoteState, settings, remotePort, saveSettings])

  const handleCopyEndpoint = useCallback(async () => {
    const result = await window.electronAPI.remoteCopyEndpoint()
    setRemoteCopied(result?.text ? '地址已复制' : '已复制')
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [])

  const handleCopyToken = useCallback(async () => {
    try {
      await window.electronAPI.remoteCopyToken()
      setRemoteCopied('Token 已复制')
    } catch (err) {
      setRemoteCopied(err?.message || '请先开启兼容模式')
    }
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [])

  const handleRotateToken = useCallback(async () => {
    const state = await window.electronAPI.remoteRotateToken()
    setRemoteState(state)
    setRemoteCopied('Token 已更新')
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [])

  const handleCreatePairingCode = useCallback(async () => {
    setPairingLoading(true)
    setPairingError('')
    try {
      const result = await window.electronAPI.remoteCreatePairingCode()
      setPairingCode(result)
      setPairingTick(Date.now())
    } catch (err) {
      setPairingError(err?.message || '生成二维码失败')
    } finally {
      setPairingLoading(false)
    }
  }, [])

  const handleCopyPairingCode = useCallback(async () => {
    if (!pairingCode?.pairingCode) return
    await window.electronAPI.remoteCopyPairingCode(pairingCode.pairingCode)
    setRemoteCopied('绑定码已复制')
    setTimeout(() => setRemoteCopied(''), 1600)
  }, [pairingCode])

  const handleRemovePairedDevice = useCallback(async (deviceId) => {
    const result = await window.electronAPI.remoteRemovePairedDevice(deviceId)
    if (result?.state) setRemoteState(result.state)
  }, [])

  const handleApprovePairingRequest = useCallback(async (requestId) => {
    const result = await window.electronAPI.remoteApprovePairingRequest(requestId)
    if (result?.state) setRemoteState(result.state)
  }, [])

  const handleRejectPairingRequest = useCallback(async (requestId) => {
    const result = await window.electronAPI.remoteRejectPairingRequest(requestId)
    if (result?.state) setRemoteState(result.state)
  }, [])

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
      setMpvStatus(status)
    } else {
      setMpvDownloadError(result.error || '未知错误')
    }
  }, [setMpvStatus])

  const handleSelectMpvPath = useCallback(async () => {
    const mpvPath = await window.electronAPI.selectMpvPath()
    if (mpvPath) {
      await saveSettings({ mpvPath })
      const status = await window.electronAPI.checkMpv()
      setMpvStatus(status)
    }
  }, [saveSettings, setMpvStatus])

  const pairingExpiresIn = pairingCode?.expiresAt
    ? Math.max(0, Math.ceil((pairingCode.expiresAt - pairingTick) / 1000))
    : 0
  const pairedDevices = remoteState?.pairedDevices || []
  const pendingPairingRequests = remoteState?.pendingPairingRequests || []

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

          <section className="settings-section">
            <h3 className="section-title">播放模式</h3>
            <p className="section-desc">控制上一首、下一首和结束后的连播方式。</p>
            <div className="playback-mode-toggle" role="group" aria-label="播放模式切换">
              <button
                className={`playback-mode-option ${playbackMode === 'order' ? 'active' : ''}`}
                onClick={() => handlePlaybackModeChange('order')}
                type="button"
              >
                顺序
              </button>
              <button
                className={`playback-mode-option ${playbackMode === 'shuffle' ? 'active' : ''}`}
                onClick={() => handlePlaybackModeChange('shuffle')}
                type="button"
              >
                随机
              </button>
              <button
                className={`playback-mode-option ${playbackMode === 'single' ? 'active' : ''}`}
                onClick={() => handlePlaybackModeChange('single')}
                type="button"
              >
                单曲
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="section-title">关闭窗口</h3>
            <p className="section-desc">设置点击电脑端窗口关闭按钮时的默认行为。</p>
            <label className="remote-toggle close-behavior-toggle">
              <input
                type="checkbox"
                checked={closeWithoutPrompt}
                onChange={(event) => handleWindowCloseModeChange(event.target.checked ? 'minimize' : 'ask')}
              />
              <span>永久不弹出关闭确认</span>
            </label>
            <div className="close-behavior-options" role="group" aria-label="关闭窗口行为">
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={windowCloseMode === 'minimize'}
                  disabled={!closeWithoutPrompt}
                  onChange={(event) => handleWindowCloseModeChange(event.target.checked ? 'minimize' : 'ask')}
                />
                <span>关闭时最小化/隐藏到后台</span>
              </label>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={windowCloseMode === 'exit'}
                  disabled={!closeWithoutPrompt}
                  onChange={(event) => handleWindowCloseModeChange(event.target.checked ? 'exit' : 'ask')}
                />
                <span>关闭时直接退出应用</span>
              </label>
            </div>
            <p className="hint close-behavior-hint">
              未勾选“永久不弹出关闭确认”时，关闭窗口仍会显示确认弹窗；勾选后会直接执行下方选择的操作。
            </p>
          </section>

          <section className="settings-section">
            <h3 className="section-title">手机访问</h3>
            <p className="section-desc">在同一局域网内用手机浏览和播放这台电脑的视频库。</p>
            <div className={`ffmpeg-status ${remoteState?.running ? 'ok' : 'warn'}`}>
              <span className={`status-dot ${remoteState?.running ? 'green' : 'yellow'}`} />
              <div className="status-content">
                <p>{remoteState?.running ? '手机访问正在运行' : '手机访问已关闭'}</p>
                <p className="hint">
                  {remoteState?.error
                    ? `启动失败: ${remoteState.error}`
                    : (remoteState?.endpoint || '开启后会显示局域网访问地址')
                  }
                </p>
              </div>
            </div>

            <div className="remote-settings-grid">
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(remoteState?.settings?.enabled)}
                  onChange={(event) => handleRemoteSave({ enabled: event.target.checked })}
                  disabled={remoteSaving}
                />
                <span>开启手机访问</span>
              </label>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={remoteState?.settings?.keepRunningInTray !== false}
                  onChange={(event) => handleRemoteSave({ keepRunningInTray: event.target.checked })}
                  disabled={remoteSaving}
                />
                <span>关闭窗口后保持运行</span>
              </label>
              <label className="remote-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(remoteState?.settings?.allowLegacyToken)}
                  onChange={(event) => handleRemoteSave({ allowLegacyToken: event.target.checked })}
                  disabled={remoteSaving}
                />
                <span>兼容旧版手动 Token</span>
              </label>
              <label className="remote-port-field">
                <span>端口</span>
                <input
                  value={remotePort}
                  onChange={(event) => setRemotePort(event.target.value.replace(/[^\d]/g, ''))}
                  onBlur={() => handleRemoteSave()}
                  inputMode="numeric"
                  disabled={remoteSaving}
                />
              </label>
            </div>

            <div className="remote-address-box">
              <span>{remoteState?.endpoint || 'http://电脑IP:38127'}</span>
              <button className="btn btn-sm" type="button" onClick={handleCopyEndpoint} disabled={!remoteState?.endpoint}>
                复制地址
              </button>
            </div>

            <div className="mpv-actions">
              <button
                className="btn btn-sm btn-primary"
                type="button"
                onClick={handleCreatePairingCode}
                disabled={!remoteState?.running || pairingLoading}
              >
                {pairingLoading ? '生成中...' : '生成扫码绑定二维码'}
              </button>
              <button className="btn btn-sm" type="button" onClick={handleCopyToken}>
                复制临时 Token
              </button>
              <button className="btn btn-sm btn-danger" type="button" onClick={handleRotateToken}>
                重新生成 Token
              </button>
            </div>
            <p className="hint remote-hint">
              推荐使用扫码绑定，每台手机会获得独立访问凭证；临时 Token 仅在开启兼容模式后可用于旧版本手动连接，且不能按设备单独管理。
              {remoteCopied && <span className="remote-copied"> {remoteCopied}</span>}
            </p>
            {pairingError ? <p className="hint error">{pairingError}</p> : null}
            {pairingCode ? (
              <div className="remote-pairing-box">
                <div className="remote-qr-wrap">
                  <img src={pairingCode.qrDataUrl} alt="手机扫码绑定二维码" />
                </div>
                <div className="remote-pairing-content">
                  <p className="remote-pairing-title">用手机端“扫描二维码”绑定</p>
                  <p className="hint">
                    {pairingExpiresIn > 0
                      ? `二维码 ${pairingExpiresIn} 秒后过期，扫码后会自动换取独立 Token。`
                      : '二维码已过期，请重新生成。'}
                  </p>
                  <div className="mpv-actions">
                    <button className="btn btn-sm" type="button" onClick={handleCopyPairingCode}>
                      复制绑定码
                    </button>
                    <button className="btn btn-sm" type="button" onClick={handleCreatePairingCode}>
                      重新生成
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {pendingPairingRequests.length ? (
              <div className="remote-device-list">
                <div className="remote-device-list-header">
                  <strong>待确认绑定</strong>
                  <span>{pendingPairingRequests.length} 个请求</span>
                </div>
                {pendingPairingRequests.map((request) => (
                  <div className="remote-device-row remote-pending-device-row" key={request.id}>
                    <div>
                      <p>{request.clientName || '手机端'}</p>
                      <span>
                        {request.platform ? `${request.platform} · ` : ''}
                        {request.expiresAt ? `二维码 ${Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))} 秒后过期` : '等待确认'}
                      </span>
                    </div>
                    <div className="remote-device-actions">
                      <button
                        className="btn btn-sm btn-primary"
                        type="button"
                        onClick={() => handleApprovePairingRequest(request.id)}
                      >
                        允许
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        type="button"
                        onClick={() => handleRejectPairingRequest(request.id)}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="remote-device-list">
              <div className="remote-device-list-header">
                <strong>已绑定设备</strong>
                <span>{pairedDevices.length} 台</span>
              </div>
              {pairedDevices.length ? pairedDevices.map((device) => (
                <div className="remote-device-row" key={device.id}>
                  <div>
                    <p>{device.name || '手机端'}</p>
                    <span>
                      {device.lastSeenAt
                        ? `上次连接 ${new Date(device.lastSeenAt).toLocaleString()}`
                        : `绑定于 ${new Date(device.createdAt).toLocaleString()}`}
                    </span>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    type="button"
                    onClick={() => handleRemovePairedDevice(device.id)}
                  >
                    移除
                  </button>
                </div>
              )) : (
                <p className="hint">还没有通过二维码绑定的手机。</p>
              )}
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
                  <button className="btn btn-sm btn-primary" onClick={handleCheckUpdate} type="button">
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

          <section className="settings-section">
            <h3 className="section-title">About</h3>
            <div className="about-info">
              <span>Wallpaper Player</span>
              <span>License: Apache-2.0</span>
            </div>
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
          <span className="settings-version">当前版本 v{appVersion || 'unknown'}</span>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
