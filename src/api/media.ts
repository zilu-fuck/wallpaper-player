import {
  ContractError, desktopPlaybackPatchSchema, desktopTargetSchema, ipcBulkTagsSchema,
  ipcFavoriteSchema, ipcPlaybackResultSchema, ipcPlaybackSchema, ipcScanSchema,
  ipcTagsSchema, legacyIpcTagsSchema, ipcTagStateSchema, tagWriteSchema, s, type DesktopPlaybackPatch, type MediaMutationTarget, type Schema, type TagWrite, type Infer
} from '@wallpaper/contracts'

export class DesktopApiError extends Error {
  currentRevision?: number
  constructor(message: string, public code = 'operation_failed', public retryable = false) { super(message) }
}

type SuccessValue<T> = T extends { success: false } ? never : T
const settingsReply = () => typeof window.electronAPI?.getSettingsFeed === 'function' && typeof window.electronAPI?.onSettingsPatched === 'function'
  ? { settingsReply: 'version-v1' as const } : undefined
async function invoke<T>(schema: Schema<T>, call: () => Promise<unknown>): Promise<SuccessValue<T>> {
  let result: T
  try { result = schema.parse(await call(), 'response') } catch (error) {
    if (error instanceof ContractError) throw new DesktopApiError('电脑响应格式无效，请重试或更新应用。', 'invalid_response')
    throw new DesktopApiError('调用电脑服务失败，请重试。', 'ipc_unavailable', true)
  }
  if (result && typeof result === 'object' && 'success' in result && result.success === false) {
    const failure = result as { error?: string, code?: string, retryable?: boolean, currentRevision?: number }
    const error = new DesktopApiError(failure.error || '操作失败', failure.code, failure.retryable)
    error.currentRevision = failure.currentRevision
    throw error
  }
  return result as SuccessValue<T>
}

export function setVideoFavorite(target: MediaMutationTarget, favorite: boolean) {
  const parsed = desktopTargetSchema.parse(target)
  const desired = s.boolean.parse(favorite)
  return invoke(ipcFavoriteSchema, () => window.electronAPI.setVideoFavorite(parsed, desired, settingsReply()))
}
export function setVideoCustomTags(target: MediaMutationTarget, tags: string[], condition?: TagWrite) {
  const parsed = desktopTargetSchema.parse(target)
  const normalized = s.array(s.string(1024, 1), 500).parse(tags)
  const version = s.optional(tagWriteSchema).parse(condition)
  const response: Schema<Infer<typeof legacyIpcTagsSchema>> = typeof window.electronAPI?.getVideoCustomTags === 'function' ? ipcTagsSchema : legacyIpcTagsSchema
  return invoke(response, () => window.electronAPI.setVideoCustomTags(parsed, normalized, version, settingsReply()))
}
export function getVideoCustomTags(target: MediaMutationTarget) {
  const parsed = desktopTargetSchema.parse(target)
  return invoke(ipcTagStateSchema, () => window.electronAPI.getVideoCustomTags(parsed, settingsReply()))
}
export function appendVideoCustomTags(targets: MediaMutationTarget[], tags: string[]) {
  const parsed = s.array(desktopTargetSchema, 10000).parse(targets)
  const normalized = s.array(s.string(1024, 1), 500).parse(tags)
  return invoke(ipcBulkTagsSchema, () => window.electronAPI.appendVideoCustomTags(parsed, normalized, settingsReply()))
}
export function getPlaybackState(target: string) {
  const parsed = s.string(32768, 1).parse(target)
  return invoke(ipcPlaybackSchema, () => window.electronAPI.getPlaybackState(parsed))
}
export function savePlaybackState(target: string, patch: DesktopPlaybackPatch) {
  const parsed = s.string(32768, 1).parse(target)
  const normalized = desktopPlaybackPatchSchema.parse(patch)
  return invoke(ipcPlaybackResultSchema, () => window.electronAPI.savePlaybackState(parsed, normalized))
}
export async function scanDirectory(directory: string, force = false) {
  const parsed = s.string(32768, 1).parse(directory)
  const refresh = s.boolean.parse(force)
  const result = await invoke(ipcScanSchema, () => window.electronAPI.scanDirectory(parsed, refresh))
  if ('error' in result) throw new DesktopApiError(result.error, 'scan_failed', true)
  return result
}
