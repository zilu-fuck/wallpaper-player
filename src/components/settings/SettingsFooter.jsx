export default function SettingsFooter({ appVersion, saving, onCancel, onSave }) {
  return (
    <div className="settings-footer">
      <span className="settings-version">当前版本 v{appVersion || 'unknown'}</span>
      <button className="btn btn-ghost" onClick={onCancel} type="button">取消</button>
      <button className="btn btn-primary" onClick={onSave} disabled={saving} type="button">
        {saving ? '保存中...' : '保存设置'}
      </button>
    </div>
  )
}
