import { useMemo, useState, useCallback, useRef } from 'react'
import { appendVideoCustomTags, getVideoCustomTags, setVideoCustomTags } from '../api/media'

function parseTagText(value) {
  return [...new Set(String(value || '').split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))]
}

function getVideoKey(video) {
  return video?.favoriteKey || video?.fullPath || ''
}

function getLegacyVideoKey(video) {
  const key = getVideoKey(video)
  const legacyKey = video?.fullPath || ''
  return legacyKey && legacyKey !== key ? legacyKey : ''
}

export function useTagEditor({ settings, reconcileSettings }) {
  const [tagEditorVideo, setTagEditorVideo] = useState(null)
  const [tagEditorValue, setTagEditorValue] = useState('')
  const [tagEditorLoading, setTagEditorLoading] = useState(false)
  const [tagEditorError, setTagEditorError] = useState('')
  const editorGenerationRef = useRef(0)
  const editorSessionRef = useRef(null)
  const [bulkTagVideos, setBulkTagVideos] = useState([])
  const [bulkTagValue, setBulkTagValue] = useState('')
  const [selectedVideoKeys, setSelectedVideoKeys] = useState([])
  const [selectedVideoMap, setSelectedVideoMap] = useState({})

  const selectedVideoKeySet = useMemo(() => new Set(selectedVideoKeys), [selectedVideoKeys])

  const handleSetCustomTags = useCallback(async (video, tags) => {
    const tagKey = getVideoKey(video)
    if (!tagKey) return
    const result = await setVideoCustomTags(video, tags)
    await reconcileSettings?.(result)
    return result
  }, [reconcileSettings])

  const handleAppendCustomTags = useCallback(async (videos, tags) => {
    const normalizedTags = Array.isArray(tags)
      ? [...new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))]
      : []
    const targetVideos = Array.isArray(videos) ? videos.filter(Boolean) : []
    if (!targetVideos.length || !normalizedTags.length) return

    const result = await appendVideoCustomTags(targetVideos, normalizedTags)
    await reconcileSettings?.(result)
    return result
  }, [reconcileSettings])

  const handleOpenTagEditor = useCallback(async (video) => {
    const generation = ++editorGenerationRef.current
    const target = { ...video }
    editorSessionRef.current = null
    setTagEditorVideo(target)
    setTagEditorLoading(true)
    setTagEditorError('')
    const tags = settings?.customTags?.[getVideoKey(video)] ||
      settings?.customTags?.[getLegacyVideoKey(video)] || []
    setTagEditorValue(tags.join(', '))
    try {
      const snapshot = typeof window.electronAPI?.getVideoCustomTags === 'function' ? await getVideoCustomTags(target) : null
      await reconcileSettings?.(snapshot)
      if (generation !== editorGenerationRef.current) return
      editorSessionRef.current = { target, expectedRevision: snapshot?.customTagsRevision, generation, attempt: null }
      setTagEditorValue((snapshot?.customTags || tags).join(', '))
    } catch (error) {
      if (generation === editorGenerationRef.current) setTagEditorError(error?.message || '读取标签失败，请重试')
    } finally {
      if (generation === editorGenerationRef.current) setTagEditorLoading(false)
    }
  }, [settings, reconcileSettings])

  const handleReloadTagEditor = useCallback(() => {
    if (tagEditorVideo) return handleOpenTagEditor(tagEditorVideo)
  }, [handleOpenTagEditor, tagEditorVideo])

  const handleCloseTagEditor = useCallback(() => {
    editorGenerationRef.current += 1
    editorSessionRef.current = null
    setTagEditorVideo(null)
    setTagEditorValue('')
    setTagEditorLoading(false)
    setTagEditorError('')
  }, [])

  const handleSaveTagEditor = useCallback(async () => {
    if (!tagEditorVideo) return
    const session = editorSessionRef.current
    if (!session) throw new Error('标签尚未读取成功，请重新载入')
    const tags = parseTagText(tagEditorValue)
    const fingerprint = JSON.stringify(tags)
    if (!session.attempt || session.attempt.fingerprint !== fingerprint) {
      session.attempt = { fingerprint, operationId: `tags_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` }
    }
    try {
      const result = await setVideoCustomTags(session.target, tags, session.expectedRevision === undefined ? undefined : {
        expectedRevision: session.expectedRevision, operationId: session.attempt.operationId
      })
      await reconcileSettings?.(result)
      if (session.generation === editorGenerationRef.current) handleCloseTagEditor()
    } catch (error) {
      if (session.generation === editorGenerationRef.current) {
        setTagEditorError(error?.message || '标签保存失败')
        throw error
      }
    }
  }, [tagEditorVideo, tagEditorValue, handleCloseTagEditor, reconcileSettings])

  const handleToggleVideoSelection = useCallback((video) => {
    const key = getVideoKey(video)
    if (!key) return
    const selected = selectedVideoKeySet.has(key)
    setSelectedVideoKeys(current => selected
      ? current.filter(item => item !== key)
      : [...current, key])
    setSelectedVideoMap(current => {
      const nextMap = { ...current }
      if (selected) {
        delete nextMap[key]
      } else {
        nextMap[key] = video
      }
      return nextMap
    })
  }, [selectedVideoKeySet])

  const handleSelectOnlyVideo = useCallback((video) => {
    const key = getVideoKey(video)
    if (!key) return
    setSelectedVideoKeys([key])
    setSelectedVideoMap({ [key]: video })
  }, [])

  const handleClearVideoSelection = useCallback(() => {
    setSelectedVideoKeys([])
    setSelectedVideoMap({})
  }, [])

  const handleOpenBulkTagEditor = useCallback(() => {
    const targetVideos = selectedVideoKeys
      .map(key => selectedVideoMap[key])
      .filter(Boolean)
    if (!targetVideos.length) return
    setBulkTagVideos(targetVideos)
    setBulkTagValue('')
  }, [selectedVideoKeys, selectedVideoMap])

  const handleCloseBulkTagEditor = useCallback(() => {
    setBulkTagVideos([])
    setBulkTagValue('')
  }, [])

  const handleSaveBulkTagEditor = useCallback(async () => {
    const tags = parseTagText(bulkTagValue)
    if (!bulkTagVideos.length || !tags.length) return
    const result = await handleAppendCustomTags(bulkTagVideos, tags)
    if (result?.failed?.length) {
      const failedVideos = result.failed.map(item => bulkTagVideos[item.index]).filter(Boolean)
      setBulkTagVideos(failedVideos)
      setSelectedVideoKeys(failedVideos.map(getVideoKey))
      setSelectedVideoMap(Object.fromEntries(failedVideos.map(video => [getVideoKey(video), video])))
      throw new Error('已更新 ' + result.updatedCount + ' 项，' + result.failed.length + ' 项失败，请检查后重试')
    }
    handleCloseBulkTagEditor()
    handleClearVideoSelection()
  }, [bulkTagVideos, bulkTagValue, handleAppendCustomTags, handleCloseBulkTagEditor, handleClearVideoSelection])

  return {
    tagEditorVideo,
    tagEditorValue,
    tagEditorLoading,
    tagEditorError,
    handleReloadTagEditor,
    setTagEditorValue,
    bulkTagVideos,
    bulkTagValue,
    setBulkTagValue,
    selectedVideoKeys,
    selectedVideoKeySet,
    selectedVideoMap,
    handleOpenTagEditor,
    handleCloseTagEditor,
    handleSaveTagEditor,
    handleSetCustomTags,
    handleAppendCustomTags,
    handleToggleVideoSelection,
    handleSelectOnlyVideo,
    handleClearVideoSelection,
    handleOpenBulkTagEditor,
    handleCloseBulkTagEditor,
    handleSaveBulkTagEditor
  }
}
