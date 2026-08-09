import { useState, useCallback, useEffect } from 'react'

/**
 * 设置页「手机访问」区块：远程服务开关、端口、扫码绑定、设备管理。
 * 从 Settings.jsx 拆出，自持状态与订阅，避免 Settings 继续膨胀。
 */
export default function RemoteAccessSection({ settings, saveSettings }) {
  const [remoteState, setRemoteState] = useState(null)
  const [remoteSaving, setRemoteSaving] = useState(false)
  const [remotePort, setRemotePort] = useState(String(settings?.remoteAccess?.port || 38127))
  const [remoteCopied, setRemoteCopied] = useState('')
  const [pairingCode, setPairingCode] = useState(null)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [pairingTick, setPairingTick] = useState(Date.now())

  // 设置变化时同步端口默认值
  useEffect(() => {
    setRemotePort(String(settings?.remoteAccess?.port || 38127))
  }, [settings?.remoteAccess?.port])

  // 订阅远程访问状态
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

  // 二维码生成后每秒刷新过期时间并同步最新状态
  useEffect(() => {
    if (!pairingCode) return undefined
    const timer = setInterval(() => {
      setPairingTick(Date.now())
      window.electronAPI.remoteGetState?.().then(setRemoteState)
    }, 1000)
    return () => clearInterval(timer)
  }, [pairingCode])

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
    try {
      const state = await window.electronAPI.remoteSaveSettings(next)
      setRemoteState(state)
      await saveSettings({ remoteAccess: state.settings })
    } finally {
      setRemoteSaving(false)
    }
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

  const pairingExpiresIn = pairingCode?.expiresAt
    ? Math.max(0, Math.ceil((pairingCode.expiresAt - pairingTick) / 1000))
    : 0
  const pairedDevices = remoteState?.pairedDevices || []
  const pendingPairingRequests = remoteState?.pendingPairingRequests || []

  return (
    <section className="settings-section">
      <h3 className="section-title">手机访问</h3>
      <p className="section-desc">在同一局域网内用手机浏览和播放这台电脑的视频库。</p>
      {remoteState?.identityCorruptedAt ? (
        <div className="settings-warning" style={{ marginBottom: 12 }}>
          <span>设备身份文件已损坏，已自动生成新身份。所有已绑定的手机需要重新扫码绑定。</span>
        </div>
      ) : null}
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
            <div className="remote-device-actions">
              <button
                className="btn btn-sm btn-danger"
                type="button"
                onClick={() => handleRemovePairedDevice(device.id)}
              >
                移除
              </button>
            </div>
          </div>
        )) : (
          <p className="hint">还没有通过二维码绑定的手机。</p>
        )}
      </div>
    </section>
  )
}
