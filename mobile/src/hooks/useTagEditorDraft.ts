import { useCallback, useEffect, useState } from 'react'
import { uniqueText } from '../screens/player/playerUtils'
import type { VideoItem } from '../types'

export function useTagEditorDraft(video: VideoItem, editKey: number) {
  const [tags, setTags] = useState(() => uniqueText(video.customTags || []))
  const [text, setText] = useState('')
  useEffect(() => { setTags(uniqueText(video.customTags || [])); setText('') }, [video.id, editKey])
  const toggle = useCallback((tag: string) => setTags(current => current.includes(tag)
    ? current.filter(item => item !== tag) : [...current, tag]), [])
  const add = useCallback(() => {
    const next = text.trim()
    if (!next) return
    setTags(current => current.includes(next) ? current : [...current, next]); setText('')
  }, [text])
  return { tags, text, setText, toggle, add }
}
export type TagEditorDraft = ReturnType<typeof useTagEditorDraft>
