import { useRemoteSettings } from '../../hooks/useRemoteSettings'

export default function RemoteAccessSection({ settings }) {
  const {
    remoteState, remoteSaving, remotePort, remoteCopied, remoteBusy, remoteDirty, remoteError, remoteLoadError, remoteLoading,
    pairingCode, pairingLoading, pairingTick, setRemotePort, handleRemoteSave, refreshRemote,
    handleCopyEndpoint, handleCopyToken, handleRotateToken, handleCreatePairingCode, handleCopyPairingCode,
    handleRemovePairedDevice, handleApprovePairingRequest, handleRejectPairingRequest
  } = useRemoteSettings(settings)
  const pairingExpiresIn = pairingCode?.expiresAt
    ? Math.max(0, Math.ceil((pairingCode.expiresAt - pairingTick) / 1000))
    : 0
  const pairedDevices = remoteState?.pairedDevices || []
  const pendingPairingRequests = remoteState?.pendingPairingRequests || []
  const identityUnavailable = Boolean(remoteState?.error && !remoteState?.accessToken)

  return (
    <section className="settings-section">
      <h3 className="section-title">手机访问</h3>
      <p className="section-desc">在同一局域网内用手机浏览和播放这台电脑的视频库。</p>
      {remoteError || remoteLoadError ? <p className="hint error" role="alert">{remoteError || remoteLoadError}</p> : null}
      {remoteLoading ? <p className="hint" role="status">正在读取手机访问状态...</p> : null}
      <button className="btn btn-sm" type="button" onClick={refreshRemote} disabled={Boolean(remoteBusy) || remoteLoading}>刷新状态</button>
      {identityUnavailable ? (
        <div className="settings-warning" role="alert" style={{ marginBottom: 12 }}>
          <span>设备身份无法读取，原文件已保留，手机访问已暂停。修复身份文件后点击“刷新状态”恢复连接。</span>
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
            disabled={Boolean(remoteBusy) || !remoteState || identityUnavailable}
          />
          <span>开启手机访问</span>
        </label>
        <label className="remote-toggle">
          <input
            type="checkbox"
            checked={remoteState?.settings?.keepRunningInTray !== false}
            onChange={(event) => handleRemoteSave({ keepRunningInTray: event.target.checked })}
            disabled={Boolean(remoteBusy) || !remoteState || identityUnavailable}
          />
          <span>关闭窗口后保持运行</span>
        </label>
        <label className="remote-toggle">
          <input
            type="checkbox"
            checked={Boolean(remoteState?.settings?.allowLegacyToken)}
            onChange={(event) => handleRemoteSave({ allowLegacyToken: event.target.checked })}
            disabled={Boolean(remoteBusy) || !remoteState || identityUnavailable}
          />
          <span>兼容旧版手动 Token</span>
        </label>
        <label className="remote-port-field">
          <span>端口</span>
          <input
            value={remotePort}
            onChange={(event) => setRemotePort(event.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={event => { if (event.key === 'Enter' && !remoteBusy) void handleRemoteSave() }}
            inputMode="numeric"
            disabled={!remoteState || identityUnavailable}
          />
          <button className="btn btn-sm" type="button" onClick={() => handleRemoteSave()} disabled={Boolean(remoteBusy) || !remoteDirty || !remoteState || identityUnavailable}>{remoteSaving ? '保存中...' : '保存端口'}</button>
          {remoteDirty ? <small className="hint" style={{ flexBasis: '100%' }}>端口更改尚未保存</small> : null}
        </label>
      </div>

      <div className="remote-address-box">
        <span>{remoteState?.endpoint || 'http://电脑IP:38127'}</span>
        <button className="btn btn-sm" type="button" onClick={handleCopyEndpoint} disabled={!remoteState?.endpoint || Boolean(remoteBusy)}>
          复制地址
        </button>
      </div>

      <div className="mpv-actions">
        <button
          className="btn btn-sm btn-primary"
          type="button"
          onClick={handleCreatePairingCode}
          disabled={!remoteState?.running || Boolean(remoteBusy)}
        >
          {pairingLoading ? '生成中...' : '生成扫码绑定二维码'}
        </button>
        <button className="btn btn-sm" type="button" onClick={handleCopyToken} disabled={!remoteState?.settings?.allowLegacyToken || Boolean(remoteBusy) || identityUnavailable}>
          复制临时 Token
        </button>
        <button className="btn btn-sm btn-danger" type="button" onClick={handleRotateToken} disabled={!remoteState || Boolean(remoteBusy) || identityUnavailable}>
          重新生成 Token
        </button>
      </div>
      <p className="hint remote-hint">
        推荐使用扫码绑定，每台手机会获得独立访问凭证；临时 Token 仅在开启兼容模式后可用于旧版本手动连接，且不能按设备单独管理。
        {remoteCopied && <span className="remote-copied"> {remoteCopied}</span>}
      </p>
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
              <button className="btn btn-sm" type="button" onClick={handleCopyPairingCode} disabled={pairingExpiresIn <= 0 || Boolean(remoteBusy)}>
                复制绑定码
              </button>
              <button className="btn btn-sm" type="button" onClick={handleCreatePairingCode} disabled={!remoteState?.running || Boolean(remoteBusy)}>
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
                  disabled={Boolean(remoteBusy)}
                >
                  允许
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => handleRejectPairingRequest(request.id)}
                  disabled={Boolean(remoteBusy)}
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
          <span>{identityUnavailable ? '暂不可用' : `${pairedDevices.length} 台`}</span>
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
                disabled={Boolean(remoteBusy)}
              >
                移除
              </button>
            </div>
          </div>
        )) : (
          <p className="hint">{identityUnavailable ? '身份恢复后再读取绑定记录，当前没有清空记录。' : '还没有通过二维码绑定的手机。'}</p>
        )}
      </div>
    </section>
  )
}
