import { useMemo, useState, useCallback } from 'react'

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

export function useTagEditor({ settings, saveSettings }) {
  const [tagEditorVideo, setTagEditorVideo] = useState(null)
  const [tagEditorValue, setTagEditorValue] = useState('')
  const [bulkTagVideos, setBulkTagVideos] = useState([])
  const [bulkTagValue, setBulkTagValue] = useState('')
  const [selectedVideoKeys, setSelectedVideoKeys] = useState([])
  const [selectedVideoMap, setSelectedVideoMap] = useState({})

  const selectedVideoKeySet = useMemo(() => new Set(selectedVideoKeys), [selectedVideoKeys])

  const handleSetCustomTags = useCallback(async (video, tags) => {
    const tagKey = getVideoKey(video)
    if (!tagKey) return
    const nextCustomTags = {
      ...(settings?.customTags || {})
    }
    const legacyKey = getLegacyVideoKey(video)
    if (legacyKey) delete nextCustomTags[legacyKey]

    if (tags.length > 0) {
      nextCustomTags[tagKey] = tags
    } else {
      delete nextCustomTags[tagKey]
    }

    await saveSettings({ customTags: nextCustomTags })
  }, [settings, saveSettings])

  const handleAppendCustomTags = useCallback(async (videos, tags) => {
    const normalizedTags = Array.isArray(tags)
      ? [...new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))]
      : []
    const targetVideos = Array.isArray(videos) ? videos.filter(Boolean) : []
    if (!targetVideos.length || !normalizedTags.length) return

    const nextCustomTags = {
      ...(settings?.customTags || {})
    }

    for (const video of targetVideos) {
      const tagKey = getVideoKey(video)
      if (!tagKey) continue
      const legacyKey = getLegacyVideoKey(video)
      const currentTags = [
        ...(Array.isArray(nextCustomTags[tagKey]) ? nextCustomTags[tagKey] : []),
        ...(legacyKey && Array.isArray(nextCustomTags[legacyKey]) ? nextCustomTags[legacyKey] : []),
        ...(video.customTags || [])
      ]
      nextCustomTags[tagKey] = [...new Set([...currentTags, ...normalizedTags])]
      if (legacyKey) delete nextCustomTags[legacyKey]
    }

    await saveSettings({ customTags: nextCustomTags })
  }, [settings, saveSettings])

  const handleOpenTagEditor = useCallback((video) => {
    setTagEditorVideo(video)
    setTagEditorValue((video.customTags || []).join(', '))
  }, [])

  const handleCloseTagEditor = useCallback(() => {
    setTagEditorVideo(null)
    setTagEditorValue('')
  }, [])

  const handleSaveTagEditor = useCallback(async () => {
    if (!tagEditorVideo) return
    await handleSetCustomTags(tagEditorVideo, parseTagText(tagEditorValue))
    handleCloseTagEditor()
  }, [tagEditorVideo, tagEditorValue, handleSetCustomTags, handleCloseTagEditor])

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
    await handleAppendCustomTags(bulkTagVideos, tags)
    handleCloseBulkTagEditor()
    handleClearVideoSelection()
  }, [bulkTagVideos, bulkTagValue, handleAppendCustomTags, handleCloseBulkTagEditor, handleClearVideoSelection])

  return {
    tagEditorVideo,
    tagEditorValue,
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
