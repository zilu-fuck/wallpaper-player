import { useState, useCallback } from 'react'

// 自定义标签编辑
export function useTagEditor({ settings, saveSettings }) {
  const [tagEditorVideo, setTagEditorVideo] = useState(null)
  const [tagEditorValue, setTagEditorValue] = useState('')

  const handleSetCustomTags = useCallback(async (video, tags) => {
    const tagKey = video.favoriteKey || video.fullPath
    const nextCustomTags = {
      ...(settings?.customTags || {})
    }

    if (tags.length > 0) {
      nextCustomTags[tagKey] = tags
    } else {
      delete nextCustomTags[tagKey]
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
    const tags = [...new Set(tagEditorValue.split(/[,，\s]+/).map(tag => tag.trim()).filter(Boolean))]
    await handleSetCustomTags(tagEditorVideo, tags)
    handleCloseTagEditor()
  }, [tagEditorVideo, tagEditorValue, handleSetCustomTags, handleCloseTagEditor])

  return {
    tagEditorVideo,
    tagEditorValue,
    setTagEditorValue,
    handleOpenTagEditor,
    handleCloseTagEditor,
    handleSaveTagEditor,
    handleSetCustomTags
  }
}
