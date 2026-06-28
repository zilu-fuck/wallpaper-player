import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Agent图标定义 - 每个插件对应一个图标
 */
const AGENT_ICONS = {
  'video-analysis': (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 12.5a2.5 2.5 0 0 1 2.5-2.5h9a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 2 16.5v-4z" />
      <path d="M18 10l4-2v8l-4-2" />
      <path d="M7 7h.01" />
      <path d="M10 7h.01" />
    </svg>
  ),
  'ai-search': (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </svg>
  ),
  downloads: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v11" />
      <path d="M7 9l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  )
}

const AGENT_LABELS = {
  'video-analysis': '视频理解',
  'ai-search': 'AI 搜索',
  downloads: '下载中心'
}

/**
 * RightDock - VS Code风格多功能侧边栏
 *
 * 布局: [主内容区] [活动栏图标] [插件面板]
 *
 * @param {Object} props
 * @param {boolean} props.open - 侧边栏是否展开
 * @param {Array} props.tabs - 插件标签列表
 * @param {string} props.activeTab - 当前激活的标签ID
 * @param {Set<string>} props.unreadTabs - 有未读/活动提示的标签ID集合
 * @param {Function} props.onClose - 关闭侧边栏
 * @param {Function} props.onTabChange - 切换标签
 * @param {Function} props.onDropVideo - 拖入视频时的回调
 */
export default function RightDock({ open, tabs, activeTab, unreadTabs, onClose, onTabChange, onDropVideo }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const wrapperRef = useRef(null)
  const panelRef = useRef(null)

  const handleActivityClick = useCallback((tabId) => {
    if (activeTab === tabId && open) {
      onClose()
    } else {
      onTabChange(tabId)
    }
  }, [activeTab, onClose, onTabChange, open])

  // 键盘快捷键：Ctrl/Cmd + 1/2 切换插件，Esc 关闭
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!tabs.length) return
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod) {
        if (e.key === 'Escape' && open) {
          e.preventDefault()
          onClose()
        }
        return
      }
      const index = Number(e.key) - 1
      if (index >= 0 && index < tabs.length) {
        e.preventDefault()
        const tab = tabs[index]
        if (activeTab === tab.id && open) {
          onClose()
        } else {
          onTabChange(tab.id)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, onClose, onTabChange, open, tabs])

  // 拖放事件处理
  const handleDragEnter = useCallback((e) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('application/json') || e.dataTransfer.types.includes('text/plain')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    const wrapper = wrapperRef.current
    // 只有鼠标真正离开整个 wrapper（进入非子元素）时才清除高亮
    if (!wrapper || !wrapper.contains(e.relatedTarget)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    try {
      const videoData = e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain')
      if (videoData) {
        const video = JSON.parse(videoData)
        onDropVideo?.(video, activeTab)
      }
    } catch (err) {
      console.error('拖放处理失败:', err)
    }
  }, [activeTab, onDropVideo])

  // 保险：任何拖拽结束时清除高亮，防止状态卡住
  useEffect(() => {
    const handleDragEnd = () => setIsDragOver(false)
    window.addEventListener('dragend', handleDragEnd)
    return () => window.removeEventListener('dragend', handleDragEnd)
  }, [])

  const activeContent = tabs.find(tab => tab.id === activeTab)?.content

  return (
    <div
      ref={wrapperRef}
      className={`right-dock-wrapper${open ? ' open' : ''}${isDragOver ? ' drag-over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 活动栏 - 垂直图标 */}
      <div className="right-dock-activity-bar">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            className={`right-dock-activity-item${activeTab === tab.id && open ? ' active' : ''}`}
            type="button"
            onClick={() => handleActivityClick(tab.id)}
            title={`${AGENT_LABELS[tab.id] || tab.label} (${index + 1})`}
            aria-label={AGENT_LABELS[tab.id] || tab.label}
          >
            {AGENT_ICONS[tab.id] || <span>{tab.label[0]}</span>}
            {activeTab === tab.id && open && <div className="activity-active-indicator" />}
            {unreadTabs?.has?.(tab.id) && activeTab !== tab.id && (
              <span className="activity-unread-indicator" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>

      {/* 插件面板 */}
      <div
        ref={panelRef}
        className={`right-dock-panel${open ? ' open' : ''}${isDragOver ? ' drag-target' : ''}`}
      >
        {open && activeContent ? (
          <>
            {/* 面板头部 */}
            <div className="right-dock-panel-header">
              <div className="right-dock-panel-title">
                <span className="panel-agent-icon">
                  {AGENT_ICONS[activeTab]}
                </span>
                <div className="panel-agent-info">
                  <span className="panel-agent-name">{AGENT_LABELS[activeTab] || tabs.find(t => t.id === activeTab)?.label}</span>
                  <span className="panel-agent-status">在线</span>
                </div>
              </div>
              <button
                className="right-dock-close-btn"
                type="button"
                onClick={onClose}
                title="收起 (Esc)"
                aria-label="收起"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 拖放提示覆盖层 */}
            {isDragOver && (
              <div className="right-dock-drop-overlay">
                <div className="right-dock-drop-hint">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>释放以引用视频</span>
                </div>
              </div>
            )}

            {/* 面板内容 */}
            <div className="right-dock-panel-content">
              {activeContent}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
