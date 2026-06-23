export function AppearanceSection({ theme, onThemeChange }) {
  return (
    <section className="settings-section">
      <h3 className="section-title">外观</h3>
      <p className="section-desc">切换深色或亮色主题。</p>
      <div className="theme-toggle" role="group" aria-label="主题切换">
        <button
          className={`theme-option ${theme === 'dark' ? 'active' : ''}`}
          onClick={() => onThemeChange('dark')}
          type="button"
        >
          <span className="theme-swatch dark" />
          深色
        </button>
        <button
          className={`theme-option ${theme === 'light' ? 'active' : ''}`}
          onClick={() => onThemeChange('light')}
          type="button"
        >
          <span className="theme-swatch light" />
          亮色
        </button>
      </div>
    </section>
  )
}

export function PlaybackModeSection({ playbackMode, onPlaybackModeChange }) {
  return (
    <section className="settings-section">
      <h3 className="section-title">播放模式</h3>
      <p className="section-desc">控制上一首、下一首和结束后的连播方式。</p>
      <div className="playback-mode-toggle" role="group" aria-label="播放模式切换">
        <button
          className={`playback-mode-option ${playbackMode === 'order' ? 'active' : ''}`}
          onClick={() => onPlaybackModeChange('order')}
          type="button"
        >
          顺序
        </button>
        <button
          className={`playback-mode-option ${playbackMode === 'shuffle' ? 'active' : ''}`}
          onClick={() => onPlaybackModeChange('shuffle')}
          type="button"
        >
          随机
        </button>
        <button
          className={`playback-mode-option ${playbackMode === 'single' ? 'active' : ''}`}
          onClick={() => onPlaybackModeChange('single')}
          type="button"
        >
          单曲
        </button>
      </div>
    </section>
  )
}

export function WindowCloseSection({ windowCloseMode, closeWithoutPrompt, onModeChange }) {
  return (
    <section className="settings-section">
      <h3 className="section-title">关闭窗口</h3>
      <p className="section-desc">设置点击电脑端窗口关闭按钮时的默认行为。</p>
      <label className="remote-toggle close-behavior-toggle">
        <input
          type="checkbox"
          checked={closeWithoutPrompt}
          onChange={(event) => onModeChange(event.target.checked ? 'minimize' : 'ask')}
        />
        <span>永久不弹出关闭确认</span>
      </label>
      <div className="close-behavior-options" role="group" aria-label="关闭窗口行为">
        <label className="remote-toggle">
          <input
            type="checkbox"
            checked={windowCloseMode === 'minimize'}
            disabled={!closeWithoutPrompt}
            onChange={(event) => onModeChange(event.target.checked ? 'minimize' : 'ask')}
          />
          <span>关闭时最小化/隐藏到后台</span>
        </label>
        <label className="remote-toggle">
          <input
            type="checkbox"
            checked={windowCloseMode === 'exit'}
            disabled={!closeWithoutPrompt}
            onChange={(event) => onModeChange(event.target.checked ? 'exit' : 'ask')}
          />
          <span>关闭时直接退出应用</span>
        </label>
      </div>
      <p className="hint close-behavior-hint">
        未勾选“永久不弹出关闭确认”时，关闭窗口仍会显示确认弹窗；勾选后会直接执行下方选择的操作。
      </p>
    </section>
  )
}
