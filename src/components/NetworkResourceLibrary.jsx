import { useCallback, useEffect, useMemo, useState } from 'react'

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.mov',
  '.avi',
  '.flv',
  '.wmv',
  '.m4v',
  '.ts'
])

function parseResource(resource) {
  const url = String(resource?.url || '').trim()
  const title = String(resource?.title || '').trim()
  const isWebpage = resource?.kind === 'webpage'
  const isWebpageShell = Boolean(isWebpage && resource?.page?.openMode === 'webview' && !resource?.playbackUrl)
  const fallback = {
    name: title || '网络资源',
    host: '',
    path: url,
    kind: '链接',
    tag: 'URL',
    isLan: false
  }

  try {
    const parsed = new URL(url)
    const pathname = decodeURIComponent(parsed.pathname || '')
    const fileName = pathname.split('/').filter(Boolean).pop() || ''
    const ext = (fileName.match(/\.[^.]+$/)?.[0] || '').toLowerCase()
    const host = parsed.host || parsed.hostname
    const hostname = parsed.hostname.toLowerCase()
    const isLan = (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.includes('nas') ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    )

    let kind = isWebpageShell ? '网页入口' : (isWebpage ? '网页剧集' : (isLan ? '局域网' : '视频链接'))
    let tag = ext ? ext.slice(1).toUpperCase() : 'URL'
    if (isWebpageShell) {
      tag = 'WEB'
    } else if (isWebpage) {
      tag = resource?.page?.episodeCount ? `${resource.page.episodeCount}集` : 'WEB'
    } else if (ext === '.m3u8') {
      kind = 'HLS'
      tag = 'M3U8'
    } else if (ext === '.mpd') {
      kind = 'DASH'
      tag = 'MPD'
    } else if (!VIDEO_EXTENSIONS.has(ext)) {
      kind = isLan ? '局域网' : '链接'
    }

    return {
      name: title || resource?.page?.currentEpisodeTitle || fileName || host || '网络资源',
      host,
      path: pathname || parsed.href,
      kind,
      tag,
      isLan,
      isWebpage,
      isWebpageShell
    }
  } catch {
    return fallback
  }
}

function formatDate(value) {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未记录'
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

function getResourceKey(resource) {
  return String(resource?.id || resource?.url || '')
}

export default function NetworkResourceLibrary({
  resources = [],
  onPlay,
  onSettingsChanged
}) {
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState('list')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [editResource, setEditResource] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editError, setEditError] = useState('')
  const [editing, setEditing] = useState(false)
  const [deleteRequest, setDeleteRequest] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState('')

  const enrichedResources = useMemo(() => (
    resources.map(resource => ({
      ...resource,
      meta: parseResource(resource)
    }))
  ), [resources])

  const filteredResources = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return enrichedResources
    return enrichedResources.filter(resource => {
      const meta = resource.meta
      return [
        meta.name,
        meta.host,
        meta.path,
        meta.kind,
        resource.url
      ].some(value => String(value || '').toLowerCase().includes(keyword))
    })
  }, [enrichedResources, query])

  const selectedResources = useMemo(() => (
    enrichedResources.filter(resource => selectedIds.has(getResourceKey(resource)))
  ), [enrichedResources, selectedIds])

  const visibleSelectableIds = useMemo(() => (
    filteredResources.map(getResourceKey).filter(Boolean)
  ), [filteredResources])

  const visibleSelectedCount = useMemo(() => (
    visibleSelectableIds.filter(id => selectedIds.has(id)).length
  ), [selectedIds, visibleSelectableIds])

  const allVisibleSelected = visibleSelectableIds.length > 0 && visibleSelectedCount === visibleSelectableIds.length

  const closeDeleteDialog = useCallback(() => {
    setDeleteRequest(null)
    setDeleteError('')
  }, [])

  const closeEditDialog = useCallback(() => {
    setEditResource(null)
    setEditTitle('')
    setEditUrl('')
    setEditError('')
    setEditing(false)
  }, [])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [query])

  useEffect(() => {
    const validIds = new Set(enrichedResources.map(getResourceKey).filter(Boolean))
    setSelectedIds(prev => {
      const next = new Set(Array.from(prev).filter(id => validIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [enrichedResources])

  useEffect(() => {
    if (!deleteRequest) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !deleting) {
        closeDeleteDialog()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeDeleteDialog, deleteRequest, deleting])

  useEffect(() => {
    if (!editResource) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !editing) {
        closeEditDialog()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeEditDialog, editResource, editing])

  const openAddResource = useCallback(() => {
    window.dispatchEvent(new CustomEvent('wallpaper-player-open-resource-dialog', {
      detail: { mode: 'network' }
    }))
  }, [])

  const downloadResource = useCallback((resource) => {
    window.dispatchEvent(new CustomEvent('wallpaper-player-open-download-center', {
      detail: {
        type: 'network',
        resource
      }
    }))
  }, [])

  const toggleResourceSelection = useCallback((resource) => {
    const key = getResourceKey(resource)
    if (!key) return
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const toggleVisibleSelection = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        visibleSelectableIds.forEach(id => next.delete(id))
      } else {
        visibleSelectableIds.forEach(id => next.add(id))
      }
      return next
    })
  }, [allVisibleSelected, visibleSelectableIds])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const requestDeleteResource = useCallback((resource) => {
    setMessage('')
    setDeleteError('')
    setDeleteRequest({
      type: 'single',
      resources: [resource]
    })
  }, [])

  const requestEditResource = useCallback((resource) => {
    setMessage('')
    setEditError('')
    setEditResource(resource)
    setEditTitle(resource?.title || '')
    setEditUrl(resource?.url || '')
  }, [])

  const submitEditResource = useCallback(async (event) => {
    event.preventDefault()
    if (!editResource?.id) {
      setEditError('资源缺少 ID，无法修改。')
      return
    }
    if (!editUrl.trim()) {
      setEditError('请输入网络地址。')
      return
    }
    setEditing(true)
    setEditError('')
    try {
      const result = await window.electronAPI?.updateNetworkResource?.({
        id: editResource.id,
        title: editTitle,
        url: editUrl
      })
      if (!result?.success) {
        setEditError(result?.error || '修改网络资源失败')
        return
      }
      if (result.settings) {
        onSettingsChanged?.(result.settings)
      }
      closeEditDialog()
      setMessage('网络资源已更新。')
    } catch (err) {
      setEditError(err?.message || '修改网络资源失败')
    } finally {
      setEditing(false)
    }
  }, [closeEditDialog, editResource, editTitle, editUrl, onSettingsChanged])

  const requestDeleteSelected = useCallback(() => {
    if (selectedResources.length === 0) return
    setMessage('')
    setDeleteError('')
    setDeleteRequest({
      type: 'batch',
      resources: selectedResources
    })
  }, [selectedResources])

  const confirmDelete = useCallback(async () => {
    const targets = deleteRequest?.resources || []
    const deletableTargets = targets.filter(resource => resource?.id)
    if (deletableTargets.length === 0) {
      setDeleteError('资源缺少 ID，无法移除。')
      return
    }
    setDeleting(true)
    setMessage('')
    setDeleteError('')
    try {
      const ids = deletableTargets.map(resource => resource.id)
      if (deleteRequest?.type === 'batch' && !window.electronAPI?.removeNetworkResources) {
        setDeleteError('当前程序需要重启后才能使用批量删除。')
        return
      }
      const result = deleteRequest?.type === 'batch' && window.electronAPI?.removeNetworkResources
        ? await window.electronAPI.removeNetworkResources(ids)
        : await window.electronAPI?.removeNetworkResource?.(ids[0])
      if (!result?.success) {
        setDeleteError(result?.error || '移除网络资源失败')
        return
      }
      if (result.settings) {
        onSettingsChanged?.(result.settings)
      }
      const successfulIds = new Set(deletableTargets.map(getResourceKey))
      const removedCount = result.removedCount ?? deletableTargets.length
      setSelectedIds(prev => new Set(Array.from(prev).filter(id => !successfulIds.has(id))))
      closeDeleteDialog()
      setMessage(`已移除 ${removedCount} 个网络资源。`)
    } catch (err) {
      setDeleteError(err?.message || '移除网络资源失败')
    } finally {
      setDeleting(false)
    }
  }, [closeDeleteDialog, deleteRequest, onSettingsChanged])

  const renderActions = (resource) => {
    const downloadable = !resource.meta.isWebpageShell
    return (
    <div className="network-resource-actions">
      <button
        type="button"
        className="network-resource-action primary"
        onClick={() => onPlay?.(resource)}
        title="播放"
        aria-label={`播放 ${resource.meta.name}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <polygon points="6 4 20 12 6 20 6 4" />
        </svg>
        <span>播放</span>
      </button>
      <button
        type="button"
        className="network-resource-action"
        onClick={() => downloadable && downloadResource(resource)}
        disabled={!downloadable}
        title={downloadable ? (resource.meta.isWebpage ? '解析后下载' : '下载') : '网页入口暂不支持下载'}
        aria-label={`${downloadable ? (resource.meta.isWebpage ? '解析后下载' : '下载') : '暂不支持下载'} ${resource.meta.name}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        <span>{downloadable ? (resource.meta.isWebpage ? '解析下载' : '下载') : '仅观看'}</span>
      </button>
      <button
        type="button"
        className="network-resource-action"
        onClick={() => requestEditResource(resource)}
        title="编辑"
        aria-label={`编辑 ${resource.meta.name}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        <span>编辑</span>
      </button>
      <button
        type="button"
        className="network-resource-action danger"
        onClick={() => requestDeleteResource(resource)}
        title="移除"
        aria-label={`移除 ${resource.meta.name}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
        </svg>
        <span>移除</span>
      </button>
    </div>
    )
  }

  const deleteCount = deleteRequest?.resources?.length || 0
  const deletePreview = deleteRequest?.resources?.slice(0, 4) || []

  return (
    <section className="network-library" aria-label="网络资源库">
      <div className="network-library-head">
        <div>
          <h2>网络资源库</h2>
          <span>{resources.length} 个资源</span>
        </div>
        <button type="button" className="btn btn-sm btn-primary" onClick={openAddResource}>
          添加网络资源
        </button>
      </div>

      <div className="network-library-toolbar">
        <div className="network-library-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、地址或主机"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="network-library-tools">
          {filteredResources.length > 0 && (
            <div className="network-bulk-bar">
              <button type="button" className="network-select-toggle" onClick={toggleVisibleSelection}>
                <span className={allVisibleSelected ? 'checked' : ''} aria-hidden="true">
                  {allVisibleSelected ? '✓' : ''}
                </span>
                {allVisibleSelected ? '取消当前结果' : '全选当前结果'}
              </button>
              {selectedIds.size > 0 && (
                <>
                  <span className="network-selected-count">已选 {selectedIds.size}</span>
                  <button type="button" className="btn btn-sm" onClick={clearSelection}>
                    清空
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={requestDeleteSelected}>
                    删除所选
                  </button>
                </>
              )}
            </div>
          )}

          <div className="view-toggle network-library-view-toggle" aria-label="视图切换">
            <button
              type="button"
              className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title="列表视图"
              aria-label="列表视图"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 6h13M8 12h13M8 18h13" />
                <path d="M3 6h.01M3 12h.01M3 18h.01" />
              </svg>
            </button>
            <button
              type="button"
              className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="网格视图"
              aria-label="网格视图"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {message && <div className="network-library-message">{message}</div>}

      {resources.length === 0 ? (
        <div className="network-library-empty">
          <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
            <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />
          </svg>
          <h3>还没有网络资源</h3>
          <button type="button" className="btn btn-primary" onClick={openAddResource}>
            添加网络资源
          </button>
        </div>
      ) : filteredResources.length === 0 ? (
        <div className="network-library-empty compact">
          <h3>没有匹配的资源</h3>
          <button type="button" className="btn btn-sm" onClick={() => setQuery('')}>
            清空搜索
          </button>
        </div>
      ) : (
        <div className={`network-resource-${viewMode}`}>
          {filteredResources.map(resource => (
            <article
              className={`network-resource-item${selectedIds.has(getResourceKey(resource)) ? ' selected' : ''}`}
              key={resource.id || resource.url}
              title={resource.url}
            >
              <button
                type="button"
                className="network-resource-check"
                onClick={() => toggleResourceSelection(resource)}
                title={selectedIds.has(getResourceKey(resource)) ? '取消选择' : '选择'}
                aria-label={`${selectedIds.has(getResourceKey(resource)) ? '取消选择' : '选择'} ${resource.meta.name}`}
              >
                {selectedIds.has(getResourceKey(resource)) && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
              <div className="network-resource-main">
                <div className="network-resource-icon" aria-hidden="true">
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
                    <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />
                  </svg>
                </div>
                <div className="network-resource-copy">
                  <div className="network-resource-title-row">
                    <h3>{resource.meta.name}</h3>
                    <span className={`network-resource-badge${resource.meta.isLan ? ' lan' : ''}`}>
                      {resource.meta.kind}
                    </span>
                  </div>
                  <p>{resource.url}</p>
                  <div className="network-resource-meta">
                    <span>{resource.meta.host || '未知主机'}</span>
                    <span>{resource.meta.tag}</span>
                    {resource.meta.isWebpage && resource.page?.currentEpisodeTitle && (
                      <span>{resource.page.currentEpisodeTitle}</span>
                    )}
                    <span>{formatDate(resource.createdAt)}</span>
                  </div>
                </div>
              </div>
              {renderActions(resource)}
            </article>
          ))}
        </div>
      )}

      {deleteRequest && (
        <div className="network-confirm-overlay" onClick={() => { if (!deleting) closeDeleteDialog() }}>
          <div className="network-confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>{deleteRequest.type === 'batch' ? `移除 ${deleteCount} 个网络资源` : '移除网络资源'}</h3>
            <p>只会从资源库移除，不会删除远程文件。</p>
            <div className="network-confirm-list">
              {deletePreview.map(resource => (
                <div className="network-confirm-target" key={resource.id || resource.url}>
                  {resource.meta?.name || resource.title || resource.url}
                </div>
              ))}
              {deleteCount > deletePreview.length && (
                <div className="network-confirm-more">还有 {deleteCount - deletePreview.length} 个资源</div>
              )}
            </div>
            {deleteError && (
              <div className="network-confirm-error" role="alert">
                {deleteError}
              </div>
            )}
            <div className="network-confirm-actions">
              <button type="button" className="btn btn-sm" onClick={closeDeleteDialog} disabled={deleting}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? '移除中...' : '确认移除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editResource && (
        <div className="network-confirm-overlay" onClick={() => { if (!editing) closeEditDialog() }}>
          <form className="network-confirm-dialog network-edit-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()} onSubmit={submitEditResource}>
            <h3>编辑网络资源</h3>
            <p>修改这里的显示名称和地址，不会影响远程文件。</p>
            <label className="network-edit-field">
              <span>显示名称</span>
              <input
                type="text"
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                placeholder={editResource.meta?.name || '网络资源'}
                disabled={editing}
              />
            </label>
            <label className="network-edit-field">
              <span>网络地址</span>
              <input
                type="url"
                value={editUrl}
                onChange={(event) => setEditUrl(event.target.value)}
                placeholder="https://example.com/video.m3u8"
                disabled={editing}
                required
              />
            </label>
            {editError && (
              <div className="network-confirm-error" role="alert">
                {editError}
              </div>
            )}
            <div className="network-confirm-actions">
              <button type="button" className="btn btn-sm" onClick={closeEditDialog} disabled={editing}>
                取消
              </button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={editing}>
                {editing ? '保存中...' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
