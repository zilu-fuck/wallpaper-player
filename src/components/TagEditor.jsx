import { useApp } from '../context/AppContext'

export default function TagEditor() {
  const {
    tagEditorVideo,
    tagEditorValue,
    setTagEditorValue,
    handleCloseTagEditor,
    handleSaveTagEditor
  } = useApp()

  if (!tagEditorVideo) return null

  return (
    <div className="tag-editor-overlay" onClick={handleCloseTagEditor}>
      <div className="tag-editor-panel" onClick={e => e.stopPropagation()}>
        <div className="tag-editor-header">
          <h2>自定义标签</h2>
          <button className="btn btn-icon" onClick={handleCloseTagEditor} title="关闭" aria-label="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="tag-editor-body">
          <div className="tag-editor-title" title={tagEditorVideo.name}>{tagEditorVideo.name}</div>
          <label className="tag-editor-label" htmlFor="custom-tags-input">标签</label>
          <input
            id="custom-tags-input"
            className="tag-editor-input"
            value={tagEditorValue}
            onChange={e => setTagEditorValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSaveTagEditor()
              if (e.key === 'Escape') handleCloseTagEditor()
            }}
            placeholder="用逗号或空格分隔，例如 精选 横屏 角色"
            autoFocus
          />
          <p className="tag-editor-hint">留空保存会清除该视频的自定义标签。</p>
        </div>
        <div className="tag-editor-footer">
          <button className="btn btn-outline" onClick={handleCloseTagEditor}>取消</button>
          <button className="btn btn-primary" onClick={handleSaveTagEditor}>保存</button>
        </div>
      </div>
    </div>
  )
}
