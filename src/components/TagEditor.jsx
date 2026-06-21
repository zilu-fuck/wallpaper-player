import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../context/AppContext'

function getTagKey(value) {
  return String(value || '').trim().toLocaleLowerCase()
}

function uniqueTags(tags) {
  const seen = new Set()
  const result = []

  for (const value of tags) {
    const tag = String(value || '').trim()
    const key = getTagKey(tag)
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }

  return result
}

function parseTagText(value) {
  return uniqueTags(String(value || '').split(/[,，\s]+/))
}

export default function TagEditor() {
  const {
    tagEditorVideo,
    tagEditorValue,
    setTagEditorValue,
    bulkTagVideos,
    bulkTagValue,
    setBulkTagValue,
    handleCloseTagEditor,
    handleSaveTagEditor,
    handleCloseBulkTagEditor,
    handleSaveBulkTagEditor,
    customTags = {}
  } = useApp()
  const [tagSearch, setTagSearch] = useState('')

  const isBulk = bulkTagVideos?.length > 0
  const visible = tagEditorVideo || isBulk
  const value = isBulk ? bulkTagValue : tagEditorValue
  const setValue = isBulk ? setBulkTagValue : setTagEditorValue
  const close = isBulk ? handleCloseBulkTagEditor : handleCloseTagEditor
  const save = isBulk ? handleSaveBulkTagEditor : handleSaveTagEditor
  const title = isBulk ? '批量添加标签' : '自定义标签'
  const targetTitle = isBulk ? `已选择 ${bulkTagVideos.length} 个视频` : tagEditorVideo?.name
  const hint = isBulk
    ? '会把输入的标签追加到所有已选视频，不会清除原有标签。'
    : '留空保存会清除该视频的自定义标签。'
  const currentTags = useMemo(() => parseTagText(value), [value])
  const currentTagKeys = useMemo(() => new Set(currentTags.map(getTagKey)), [currentTags])
  const existingTags = useMemo(() => {
    const tags = []

    for (const value of Object.values(customTags || {})) {
      if (Array.isArray(value)) tags.push(...value)
    }

    const targetVideos = isBulk ? bulkTagVideos : (tagEditorVideo ? [tagEditorVideo] : [])
    for (const video of targetVideos || []) {
      tags.push(...(video?.customTags || []))
      tags.push(...(video?.tags || []))
      tags.push(...(video?.systemTags || []))
    }

    return uniqueTags(tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [bulkTagVideos, customTags, isBulk, tagEditorVideo])
  const filteredExistingTags = useMemo(() => {
    const keyword = tagSearch.trim().toLocaleLowerCase()
    const matched = keyword
      ? existingTags.filter(tag => getTagKey(tag).includes(keyword))
      : existingTags

    return matched.slice(0, 40)
  }, [existingTags, tagSearch])

  useEffect(() => {
    if (!visible) setTagSearch('')
  }, [visible])

  function setTags(tags) {
    setValue(uniqueTags(tags).join(', '))
  }

  function removeTag(tag) {
    const key = getTagKey(tag)
    setTags(currentTags.filter(item => getTagKey(item) !== key))
  }

  function toggleExistingTag(tag) {
    const key = getTagKey(tag)
    setTags(currentTagKeys.has(key)
      ? currentTags.filter(item => getTagKey(item) !== key)
      : [...currentTags, tag])
  }

  if (!visible) return null

  return (
    <div className="tag-editor-overlay" onClick={close}>
      <div className="tag-editor-panel" onClick={e => e.stopPropagation()}>
        <div className="tag-editor-header">
          <h2>{title}</h2>
          <button className="btn btn-icon" onClick={close} title="关闭" aria-label="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="tag-editor-body">
          <div className="tag-editor-title" title={targetTitle}>{targetTitle}</div>
          <label className="tag-editor-label" htmlFor="custom-tags-input">标签</label>
          <input
            id="custom-tags-input"
            className="tag-editor-input"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') close()
            }}
            placeholder="用逗号或空格分隔，例如 精选 横屏 角色"
            autoFocus
          />
          {currentTags.length ? (
            <div className="tag-editor-selected-tags" aria-label="待保存标签">
              {currentTags.map(tag => (
                <button className="tag-editor-selected-chip" key={tag} type="button" onClick={() => removeTag(tag)}>
                  <span>{tag}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="tag-editor-options-head">
            <label className="tag-editor-label" htmlFor="existing-tags-search">已有标签</label>
            <span>{existingTags.length} 个</span>
          </div>
          <input
            id="existing-tags-search"
            className="tag-editor-input tag-editor-search"
            value={tagSearch}
            onChange={e => setTagSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') close()
            }}
            placeholder="搜索已有标签"
          />
          <div className="tag-editor-option-list">
            {filteredExistingTags.length ? filteredExistingTags.map(tag => {
              const selected = currentTagKeys.has(getTagKey(tag))
              return (
                <button
                  className={`tag-editor-option-chip ${selected ? 'active' : ''}`}
                  key={tag}
                  type="button"
                  onClick={() => toggleExistingTag(tag)}
                  title={selected ? '从待保存标签中移除' : '添加这个已有标签'}
                >
                  {tag}
                </button>
              )
            }) : (
              <span className="tag-editor-empty">
                {existingTags.length ? '没有匹配的标签' : '还没有已有标签'}
              </span>
            )}
          </div>
          <p className="tag-editor-hint">{hint}</p>
        </div>
        <div className="tag-editor-footer">
          <button className="btn btn-outline" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={save}>{isBulk ? '添加到已选视频' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}
