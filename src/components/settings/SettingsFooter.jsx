export default function SettingsFooter({ appVersion, onClose }) {
  return (
    <div className="settings-footer">
      <span className="settings-version">当前版本 v{appVersion || 'unknown'}</span>
      <button className="btn btn-primary" onClick={onClose} type="button">关闭</button>
    </div>
  )
}
