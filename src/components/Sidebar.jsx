import { useCallback, useEffect, useMemo, useState } from 'react'
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
    handleAddDirectory,
    handleDirectoriesChange,
    setShowSettings,
    categoryGroups = { custom: [], system: [] },
    activeCategory = 'all',
    selectedCategoryKeys = [],
    setActiveCategory,
    favoriteCount = 0,
    totalCount = 0
  } = useApp()

  const directories = settings?.directories || []
  const privateDirectories = settings?.privateDirectories || []
  const privateDirSet = useMemo(() => new Set(privateDirectories), [privateDirectories])
  const hiddenPrivateCount = useMemo(
    () => privateDirectories.filter(dir => directories.includes(dir)).length,
    [directories, privateDirectories]
  )
  const [showPrivateDirs, setShowPrivateDirs] = useState(false)
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false)
  const [privacyPassword, setPrivacyPassword] = useState('')
  const [privacyConfirmPassword, setPrivacyConfirmPassword] = useState('')
  const [privacyMessage, setPrivacyMessage] = useState('')
  const [privacySubmitting, setPrivacySubmitting] = useState(false)
  const [pendingPrivateDirectory, setPendingPrivateDirectory] = useState(null)
  const [directoryMenu, setDirectoryMenu] = useState(null)
  const [localDirs, setLocalDirs] = useState(() => directories.filter(dir => showPrivateDirs || !privateDirSet.has(dir)))
  const privacyPasswordSet = Boolean(settings?.privacy?.passwordSet)
  const selectedCategoryKeySet = useMemo(() => new Set(selectedCategoryKeys), [selectedCategoryKeys])

  useEffect(() => {
    setLocalDirs(directories.filter(dir => showPrivateDirs || !privateDirSet.has(dir)))
  }, [directories, privateDirSet, showPrivateDirs])

  useEffect(() => {
    if (!directoryMenu) return undefined
    const closeMenu = () => setDirectoryMenu(null)
    window.addEventListener('click', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [directoryMenu])

  const getPublicDirs = useCallback((dirs, privateDirs) => {
    const privateSet = new Set(privateDirs)
    return dirs.filter(dir => !privateSet.has(dir))
  }, [])

  useEffect(() => {
    if (showPrivateDirs || !currentDir || !privateDirSet.has(currentDir)) return
    const publicDirs = getPublicDirs(directories, privateDirectories)
    handleDirectoryChange(publicDirs[0] || null)
  }, [currentDir, directories, getPublicDirs, handleDirectoryChange, privateDirSet, privateDirectories, showPrivateDirs])

  useEffect(() => {
    const openPendingPrivateDirectory = (event) => {
      const dir = event.detail?.dir
      if (!dir) return
      setPendingPrivateDirectory(dir)
      setPrivacyPassword('')
      setPrivacyConfirmPassword('')
      setPrivacyMessage('')
      setPrivacyDialogOpen(true)
    }
    window.addEventListener('wallpaper-player-private-directory-password-required', openPendingPrivateDirectory)
    return () => window.removeEventListener('wallpaper-player-private-directory-password-required', openPendingPrivateDirectory)
  }, [])

  const lockPrivateDirs = useCallback(() => {
    setShowPrivateDirs(false)
    setPrivacyDialogOpen(false)
    setPrivacyPassword('')
    setPrivacyConfirmPassword('')
    setPrivacyMessage('')
    setPendingPrivateDirectory(null)
  }, [])

  const requestShowPrivateDirs = useCallback(() => {
    if (showPrivateDirs) {
      lockPrivateDirs()
      return
    }
    setPrivacyPassword('')
    setPrivacyConfirmPassword('')
    setPrivacyMessage('')
    setPrivacyDialogOpen(true)
  }, [lockPrivateDirs, showPrivateDirs])

  const closePrivacyDialog = useCallback(() => {
    setPrivacyDialogOpen(false)
    setPrivacyPassword('')
    setPrivacyConfirmPassword('')
    setPrivacyMessage('')
    setPendingPrivateDirectory(null)
  }, [])

  const savePrivateDirectory = useCallback(async (dir) => {
    const nextDirectories = directories.includes(dir) ? directories : [...directories, dir]
    const nextPrivateDirectories = [...new Set([...privateDirectories, dir])]
    const publicDirs = getPublicDirs(nextDirectories, nextPrivateDirectories)
    await handleDirectoriesChange({
      directories: nextDirectories,
      privateDirectories: nextPrivateDirectories,
      defaultDirectory: publicDirs.includes(currentDir) ? currentDir : publicDirs[0] || ''
    })
  }, [currentDir, directories, getPublicDirs, handleDirectoriesChange, privateDirectories])

  const removePrivateDirectory = useCallback(async (dir) => {
    const nextPrivateDirectories = privateDirectories.filter(item => item !== dir)
    const publicDirs = getPublicDirs(directories, nextPrivateDirectories)
    await handleDirectoriesChange({
      directories,
      privateDirectories: nextPrivateDirectories,
      defaultDirectory: publicDirs.includes(currentDir) ? currentDir : publicDirs[0] || ''
    })
  }, [currentDir, directories, getPublicDirs, handleDirectoriesChange, privateDirectories])

  const submitPrivacyPassword = useCallback(async (event) => {
    event.preventDefault()
    const password = privacyPassword
    if (password.length < 4) {
      setPrivacyMessage('隐私密码至少需要 4 位')
      return
    }
    if (!privacyPasswordSet && password !== privacyConfirmPassword) {
      setPrivacyMessage('两次输入的密码不一致')
      return
    }
    setPrivacySubmitting(true)
    setPrivacyMessage('')
    try {
      const result = privacyPasswordSet
        ? await window.electronAPI?.unlockPrivacy?.(password)
        : await window.electronAPI?.setPrivacyPassword?.(password)
      if (!result?.success) {
        setPrivacyMessage(result?.error || '隐私验证失败')
        return
      }
      if (pendingPrivateDirectory) {
        await savePrivateDirectory(pendingPrivateDirectory)
      }
      setShowPrivateDirs(true)
      closePrivacyDialog()
    } catch (err) {
      setPrivacyMessage(err?.message || '隐私验证失败')
    } finally {
      setPrivacySubmitting(false)
    }
  }, [
    closePrivacyDialog,
    currentDir,
    directories,
    getPublicDirs,
    handleDirectoriesChange,
    pendingPrivateDirectory,
    privacyConfirmPassword,
    privacyPassword,
    privacyPasswordSet,
    privateDirectories,
    savePrivateDirectory
  ])

  const saveDirs = useCallback((newDirs, nextPrivateDirs = privateDirectories) => {
    const cleanPrivateDirs = nextPrivateDirs.filter(dir => newDirs.includes(dir))
    const publicDirs = getPublicDirs(newDirs, cleanPrivateDirs)
    const newDefault = publicDirs.length > 0
      ? (publicDirs.includes(currentDir) ? currentDir : publicDirs[0])
      : ''
    handleDirectoriesChange({ directories: newDirs, privateDirectories: cleanPrivateDirs, defaultDirectory: newDefault })
  }, [currentDir, getPublicDirs, handleDirectoriesChange, privateDirectories])

  const handleAdd = useCallback(async () => {
    try {
      const result = await handleAddDirectory?.({ returnPasswordRequired: true })
      if (result?.needsPrivacyPassword && result.dir) {
        setPendingPrivateDirectory(result.dir)
        setPrivacyPassword('')
        setPrivacyConfirmPassword('')
        setPrivacyMessage('')
        setPrivacyDialogOpen(true)
      }
    } catch (err) {
      console.error('添加目录失败:', err)
    }
  }, [handleAddDirectory])

  const handleRemove = useCallback((dir, e) => {
    e.stopPropagation()
    const newDirs = directories.filter(d => d !== dir)
    const newPrivateDirs = privateDirectories.filter(d => d !== dir)
    const publicDirs = getPublicDirs(newDirs, newPrivateDirs)
    setLocalDirs(newDirs.filter(d => showPrivateDirs || !newPrivateDirs.includes(d)))
    saveDirs(newDirs, newPrivateDirs)
    if (dir === currentDir) {
      if (publicDirs.length > 0) {
        handleDirectoryChange(publicDirs[0])
      } else {
        handleDirectoryChange(null)
      }
    }
  }, [currentDir, directories, getPublicDirs, handleDirectoryChange, privateDirectories, saveDirs, showPrivateDirs])

  const handleDirectoryContextMenu = useCallback((dir, event) => {
    event.preventDefault()
    event.stopPropagation()
    setDirectoryMenu({
      dir,
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 112)
    })
  }, [])

  const handleSetDirectoryPrivate = useCallback(async (dir) => {
    setDirectoryMenu(null)
    if (!privacyPasswordSet) {
      setPendingPrivateDirectory(dir)
      setPrivacyPassword('')
      setPrivacyConfirmPassword('')
      setPrivacyMessage('')
      setPrivacyDialogOpen(true)
      return
    }
    await savePrivateDirectory(dir)
    setShowPrivateDirs(false)
  }, [privacyPasswordSet, savePrivateDirectory])

  const handleUnsetDirectoryPrivate = useCallback(async (dir) => {
    setDirectoryMenu(null)
    await removePrivateDirectory(dir)
  }, [removePrivateDirectory])

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
            className={`sidebar-category-item${selectedCategoryKeySet.has(category.key) ? ' active' : ''}`}
            onClick={() => handleCategorySelect(category.key)}
            title={category.name}
          >
            <span className="sidebar-category-name">
              <span className="sidebar-category-check" aria-hidden="true">
                {selectedCategoryKeySet.has(category.key) ? '✓' : ''}
              </span>
              {category.name}
            </span>
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
      <div className={`sidebar-collapsed-content sidebar-pane${sidebarCollapsed ? ' active' : ''}`} aria-hidden={!sidebarCollapsed}>
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
      <div className={`sidebar-full-content sidebar-pane${sidebarCollapsed ? '' : ' active'}`} aria-hidden={sidebarCollapsed}>
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
              <div className="sidebar-section-actions">
                {hiddenPrivateCount > 0 && (
                  <button
                    className={`sidebar-add-mini${showPrivateDirs ? ' active' : ''}`}
                    onClick={requestShowPrivateDirs}
                    title={showPrivateDirs ? '锁定隐私目录' : `解锁 ${hiddenPrivateCount} 个隐私目录`}
                    aria-label={showPrivateDirs ? '锁定隐私目录' : '解锁隐私目录'}
                  >
                    {showPrivateDirs ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
                        <path d="M17.94 17.94A10.9 10.9 0 0 1 12 20C7 20 2.73 16.89 1 12c.75-2.12 2.05-3.95 3.72-5.31" />
                        <path d="M9.9 4.24A10.7 10.7 0 0 1 12 4c5 0 9.27 3.11 11 8a11.8 11.8 0 0 1-2.16 3.19" />
                        <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
                        <path d="M1 1l22 22" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                )}
                <button className="sidebar-add-mini" onClick={handleAdd} title="添加目录" aria-label="添加目录">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>
            </div>

            {localDirs.length === 0 ? (
              <div className="sidebar-empty">
                <p>暂无目录</p>
                <button className="btn btn-sm btn-outline" onClick={handleAdd}>添加视频目录</button>
              </div>
            ) : (
              <div className="sidebar-dir-list">
                {localDirs.map(dir => {
                  const isPrivate = privateDirSet.has(dir)
                  return (
                  <div
                    key={dir}
                    className={`sidebar-dir-item${dir === currentDir ? ' active' : ''}${isPrivate ? ' private' : ''}`}
                    onClick={() => handleDirectoryChange(dir)}
                    onContextMenu={(event) => handleDirectoryContextMenu(dir, event)}
                    title={dir}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleDirectoryChange(dir) } }}
                  >
                    <svg className="sidebar-dir-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <div className="sidebar-dir-info">
                      <span className="sidebar-dir-name">
                        {dirName(dir)}
                        {isPrivate && <span className="sidebar-private-badge">隐私</span>}
                      </span>
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
                  )
                })}
              </div>
            )}
          </div>

          <div className="sidebar-section sidebar-category-section">
            <div className="sidebar-section-header">
              <span className="sidebar-label">分类</span>
            </div>
          <div className="sidebar-category-list">
              {selectedCategoryKeys.length > 0 ? (
                <div className="sidebar-category-filterbar">
                  <span>交集筛选 {selectedCategoryKeys.length} 项</span>
                  <button type="button" onClick={() => handleCategorySelect('all')}>清空</button>
                </div>
              ) : null}
              <button
                className={`sidebar-category-item${selectedCategoryKeys.length === 0 ? ' active' : ''}`}
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
        </div>
      {directoryMenu && (
        <div
          className="sidebar-dir-menu"
          style={{ left: directoryMenu.x, top: directoryMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {privateDirSet.has(directoryMenu.dir) ? (
            <button type="button" onClick={() => handleUnsetDirectoryPrivate(directoryMenu.dir)}>
              取消隐私目录
            </button>
          ) : (
            <button type="button" onClick={() => handleSetDirectoryPrivate(directoryMenu.dir)}>
              设为隐私目录
            </button>
          )}
          <button type="button" className="danger" onClick={(event) => handleRemove(directoryMenu.dir, event)}>
            移除目录
          </button>
        </div>
      )}
      {privacyDialogOpen && (
        <div className="privacy-dialog-overlay" onClick={closePrivacyDialog}>
          <form className="privacy-dialog" onSubmit={submitPrivacyPassword} onClick={(event) => event.stopPropagation()}>
            <div className="privacy-dialog-header">
              <h2>{privacyPasswordSet ? '解锁隐私目录' : '设置隐私密码'}</h2>
              <button type="button" className="btn btn-icon" onClick={closePrivacyDialog} aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="privacy-dialog-body">
              <label className="privacy-field">
                <span>{privacyPasswordSet ? '隐私密码' : '新隐私密码'}</span>
                <input
                  type="password"
                  value={privacyPassword}
                  onChange={(event) => setPrivacyPassword(event.target.value)}
                  autoFocus
                  minLength={4}
                />
              </label>
              {!privacyPasswordSet && (
                <label className="privacy-field">
                  <span>确认密码</span>
                  <input
                    type="password"
                    value={privacyConfirmPassword}
                    onChange={(event) => setPrivacyConfirmPassword(event.target.value)}
                    minLength={4}
                  />
                </label>
              )}
              <p className="privacy-hint">
                {privacyPasswordSet ? '解锁后仅本次打开期间显示隐私目录。' : '以后显示隐私目录时都需要输入这个密码。'}
              </p>
              {privacyMessage && <p className="privacy-error">{privacyMessage}</p>}
            </div>
            <div className="privacy-dialog-footer">
              <button type="button" className="btn btn-sm" onClick={closePrivacyDialog}>取消</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={privacySubmitting}>
                {privacySubmitting ? '处理中...' : (privacyPasswordSet ? '解锁' : '设置并显示')}
              </button>
            </div>
          </form>
        </div>
      )}
    </aside>
  )
}
