import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../context/AppContext'

function dirName(dir) {
  return dir.split(/[/\\]/).pop()
}

export default function Sidebar() {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    settings,
    currentDir,
    handleDirectoryChange,
    handleDirectoriesChange,
    setShowSettings,
    categoryGroups = { custom: [], system: [] },
    activeCategory = 'all',
    setActiveCategory,
    favoriteCount = 0,
    totalCount = 0
  } = useApp()

  const directories = settings?.directories || []
  const [localDirs, setLocalDirs] = useState(directories)

  useEffect(() => {
    setLocalDirs(directories)
  }, [directories])

  const saveDirs = useCallback((newDirs) => {
    const newDefault = newDirs.length > 0
      ? (newDirs.includes(currentDir) ? currentDir : newDirs[0])
      : ''
    handleDirectoriesChange({ directories: newDirs, defaultDirectory: newDefault })
  }, [currentDir, handleDirectoriesChange])

  const handleAdd = useCallback(async () => {
    try {
      const dir = await window.electronAPI?.selectDirectory()
      if (!dir) return
      setLocalDirs(prev => {
        if (prev.includes(dir)) return prev
        const newDirs = [...prev, dir]
        saveDirs(newDirs)
        return newDirs
      })
    } catch (err) {
      console.error('添加目录失败:', err)
    }
  }, [saveDirs])

  const handleRemove = useCallback((dir, e) => {
    e.stopPropagation()
    const newDirs = localDirs.filter(d => d !== dir)
    setLocalDirs(newDirs)
    saveDirs(newDirs)
    // 如果删除的是当前目录，切换到第一个剩余目录（或清空）
    if (dir === currentDir) {
      if (newDirs.length > 0) {
        handleDirectoryChange(newDirs[0])
      } else {
        handleDirectoryChange(null)
      }
    }
  }, [localDirs, currentDir, saveDirs, handleDirectoryChange])

  const handleCategorySelect = useCallback((categoryKey) => {
    setActiveCategory?.(categoryKey)
  }, [setActiveCategory])

  const onToggle = useCallback(() => setSidebarCollapsed(!sidebarCollapsed), [sidebarCollapsed, setSidebarCollapsed])
  const onOpenSettings = useCallback(() => setShowSettings(true), [setShowSettings])

  const renderCategoryGroup = (title, categories, emptyText) => (
    <div className="sidebar-category-group">
      <div className="sidebar-category-group-title">{title}</div>
      {categories.length > 0 ? (
        categories.map(category => (
          <button
            key={category.key}
            className={`sidebar-category-item${activeCategory === category.key ? ' active' : ''}`}
            onClick={() => handleCategorySelect(category.key)}
            title={category.name}
          >
            <span className="sidebar-category-name">{category.name}</span>
            <span className="sidebar-category-count">{category.count}</span>
          </button>
        ))
      ) : (
        <div className="sidebar-category-empty">{emptyText}</div>
      )}
    </div>
  )

  return (
    <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`} aria-label="导航">
      {sidebarCollapsed ? (
        <div className="sidebar-collapsed-content">
          <button className="sidebar-toggle-btn" onClick={onToggle} title="展开侧边栏" aria-label="展开侧边栏">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <div className="sidebar-collapsed-icons">
            <button
              className={`sidebar-icon-btn${currentDir ? ' active' : ''}`}
              onClick={() => { if (localDirs.length > 0) handleDirectoryChange(currentDir || localDirs[0]) }}
              title="目录"
              aria-label="目录"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              className={`sidebar-icon-btn${activeCategory === 'all' ? ' active' : ''}`}
              onClick={() => handleCategorySelect('all')}
              title="全部"
              aria-label="全部"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
            <button
              className={`sidebar-icon-btn${activeCategory === 'favorites' ? ' active' : ''}`}
              onClick={() => handleCategorySelect('favorites')}
              title="我喜欢"
              aria-label="我喜欢"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill={activeCategory === 'favorites' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
              </svg>
            </button>
            <button className="sidebar-icon-btn" onClick={handleAdd} title="添加目录" aria-label="添加目录">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button className="sidebar-icon-btn sidebar-settings-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="sidebar-header">
            <h1 className="sidebar-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              视频画廊
            </h1>
            <button className="sidebar-toggle-btn" onClick={onToggle} title="收起侧边栏" aria-label="收起侧边栏">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <span className="sidebar-label">目录</span>
              <button className="sidebar-add-mini" onClick={handleAdd} title="添加目录" aria-label="添加目录">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>

            {localDirs.length === 0 ? (
              <div className="sidebar-empty">
                <p>暂无目录</p>
                <button className="btn btn-sm btn-outline" onClick={handleAdd}>添加视频目录</button>
              </div>
            ) : (
              <div className="sidebar-dir-list">
                {localDirs.map(dir => (
                  <div
                    key={dir}
                    className={`sidebar-dir-item${dir === currentDir ? ' active' : ''}`}
                    onClick={() => handleDirectoryChange(dir)}
                    title={dir}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDirectoryChange(dir) } }}
                  >
                    <svg className="sidebar-dir-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <div className="sidebar-dir-info">
                      <span className="sidebar-dir-name">{dirName(dir)}</span>
                      <span className="sidebar-dir-path">{dir}</span>
                    </div>
                    <button
                      className="sidebar-dir-remove"
                      onClick={(e) => handleRemove(dir, e)}
                      title="移除"
                      aria-label={`移除 ${dirName(dir)}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="sidebar-section sidebar-category-section">
            <div className="sidebar-section-header">
              <span className="sidebar-label">分类</span>
            </div>
            <div className="sidebar-category-list">
              <button
                className={`sidebar-category-item${activeCategory === 'all' ? ' active' : ''}`}
                onClick={() => handleCategorySelect('all')}
              >
                <span className="sidebar-category-name">全部</span>
                <span className="sidebar-category-count">{totalCount}</span>
              </button>
              <button
                className={`sidebar-category-item${activeCategory === 'favorites' ? ' active' : ''}`}
                onClick={() => handleCategorySelect('favorites')}
              >
                <span className="sidebar-category-name">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={activeCategory === 'favorites' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.2">
                    <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
                  </svg>
                  我喜欢
                </span>
                <span className="sidebar-category-count">{favoriteCount}</span>
              </button>
              {renderCategoryGroup('自定义分类', categoryGroups.custom, '暂无自定义分类')}
              {renderCategoryGroup('系统分类', categoryGroups.system, '暂无系统分类')}
            </div>
          </div>

          <div className="sidebar-footer">
            <button className="sidebar-footer-btn" onClick={onOpenSettings}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
              <span>设置</span>
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
