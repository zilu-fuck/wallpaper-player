import { getVideoTagsState, updateVideoTags } from './api'
import type { StoredDevice, VideoItem } from '../types'

export type TagEditSession = {
  device: StoredDevice
  video: VideoItem
  expectedRevision?: number
  attempt?: { fingerprint: string, operationId: string }
}
export function newTagOperationId() {
  return `tags_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
}
export async function openTagEdit(device: StoredDevice, video: VideoItem): Promise<TagEditSession> {
  const snapshot = device.capabilities?.tagRevisions ? await getVideoTagsState(device, video.id) : null
  const customTags = [...(snapshot?.customTags || video.customTags || [])]
  const systemTags = video.systemTags ?? (video.tags || []).filter(tag => !(video.customTags || []).includes(tag))
  return { device: { ...device }, video: { ...video, systemTags, customTags, tags: [...new Set([...systemTags, ...customTags])],
    customTagsRevision: snapshot?.customTagsRevision ?? video.customTagsRevision },
    expectedRevision: snapshot?.customTagsRevision }
}
export async function saveTagEdit(session: TagEditSession, inputTags: string[]) {
  const tags = [...new Set(inputTags.map(tag => tag.trim()).filter(Boolean))]
  const fingerprint = JSON.stringify(tags)
  if (!session.attempt || session.attempt.fingerprint !== fingerprint) session.attempt = { fingerprint, operationId: newTagOperationId() }
  return updateVideoTags(session.device, session.video.id, tags, session.expectedRevision === undefined ? undefined
    : { expectedRevision: session.expectedRevision, operationId: session.attempt.operationId })
}
