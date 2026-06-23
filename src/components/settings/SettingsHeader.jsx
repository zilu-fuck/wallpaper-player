export default function SettingsHeader({ onClose }) {
  return (
    <div className="settings-header">
      <h2>设置</h2>
      <button className="btn btn-icon" onClick={onClose} title="关闭" type="button">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
