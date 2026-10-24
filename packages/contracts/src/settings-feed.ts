import { ContractError, jsonSchema, s, type Infer } from './schema'

export const SETTINGS_MAP_FIELDS = ['customTags', 'customTagRevisions', 'playbackStates'] as const
type JsonMap = Record<string, unknown>
export type SettingsMapDelta = { set: JsonMap; removed: string[]; order?: string[] }
const record = (value: unknown): value is JsonMap => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const own = (value: JsonMap, key: string, item: unknown) => Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true })

export function diffSettingsMap(previous: unknown, next: unknown, equality: 'identity' | 'json' = 'json'): SettingsMapDelta | null {
  if (!record(previous) || !record(next)) return null
  const set = Object.fromEntries(Object.entries(next).filter(([key, value]) => !Object.hasOwn(previous, key) ||
    (equality === 'identity' ? !Object.is(previous[key], value) : JSON.stringify(previous[key]) !== JSON.stringify(value))))
  const removed = Object.keys(previous).filter(key => !Object.hasOwn(next, key)), candidate = { ...previous }
  for (const key of removed) delete candidate[key]
  for (const [key, value] of Object.entries(set)) own(candidate, key, value)
  const keys = Object.keys(next), natural = Object.keys(candidate)
  return { set, removed, ...(keys.some((key, index) => key !== natural[index]) ? { order: keys } : {}) }
}

export function applySettingsMap(previous: unknown, delta: SettingsMapDelta): JsonMap {
  if (!record(previous)) throw new ContractError('settings.map', '缺少有效基线')
  const next = { ...previous }
  for (const key of delta.removed) delete next[key]
  for (const [key, value] of Object.entries(delta.set)) own(next, key, value)
  if (!delta.order) return next
  if (delta.order.length !== Object.keys(next).length || new Set(delta.order).size !== delta.order.length ||
      delta.order.some(key => !Object.hasOwn(next, key))) throw new ContractError('settings.map.order', '必须覆盖当前键且不重复')
  return Object.fromEntries(delta.order.map(key => [key, next[key]]))
}

export const settingsVersionSchema = s.object({ epoch: s.string(128, 1), revision: s.integer() })
export type SettingsVersion = Infer<typeof settingsVersionSchema>
export const settingsReplyOptionsSchema = s.object({ settingsReply: s.literal('version-v1') })
export type SettingsReplyOptions = Infer<typeof settingsReplyOptionsSchema>
export const settingsReadOptionsSchema = s.object({ encoding: s.literal('json-v1') })
export type SettingsReadOptions = Infer<typeof settingsReadOptionsSchema>
const snapshot = s.refine(s.record(jsonSchema), value => {
  try { settingsVersionSchema.parse(value._settingsVersion) } catch { return false }
  return !Object.hasOwn(value, 'tagMutationReceipts') && record(value.privacy) &&
    typeof value.privacy.passwordSet === 'boolean' && Object.keys(value.privacy).every(key => key === 'passwordSet')
}, '必须包含版本及经过脱敏的设置')
export const settingsFeedSchema = s.object({ kind: s.literal('settings-feed-v1'), feedId: s.string(128, 1), snapshot })
export const settingsLegacyListenerSchema = s.object({ enabled: s.boolean, sequence: s.integer(), encoding: s.optional(s.literal('json-v1')) })
const key = s.string(262144, 1), keys = s.array(key, 200000)
const mapDelta = s.object({ set: s.record(jsonSchema), removed: keys, order: s.optional(keys) })
const patch = s.refine(s.object({ kind: s.literal('settings-patch-v1'), feedId: s.string(128, 1),
  baseVersion: settingsVersionSchema, version: settingsVersionSchema, set: s.record(jsonSchema), removed: keys, maps: s.record(mapDelta) }), value => {
  const names = [...Object.keys(value.set), ...value.removed, ...Object.keys(value.maps)]
  if (new Set(names).size !== names.length || names.some(name => ['_settingsVersion', 'tagMutationReceipts'].includes(name))) return false
  if (Object.keys(value.maps).some(name => !SETTINGS_MAP_FIELDS.includes(name as typeof SETTINGS_MAP_FIELDS[number]))) return false
  if (Object.hasOwn(value.set, 'privacy') && (!record(value.set.privacy) || typeof value.set.privacy.passwordSet !== 'boolean' ||
      Object.keys(value.set.privacy).some(name => name !== 'passwordSet'))) return false
  return value.version.epoch === value.baseVersion.epoch && value.version.revision > value.baseVersion.revision
}, '必须是同一世代的安全、无重叠设置增量')
export const settingsEventSchema = s.union(patch, s.object({ kind: s.literal('settings-snapshot-v1'), feedId: s.string(128, 1), snapshot }),
  s.object({ kind: s.literal('settings-resync-v1'), feedId: s.string(128, 1), version: settingsVersionSchema }))
export type SettingsFeed = Infer<typeof settingsFeedSchema>
export type SettingsEvent = Infer<typeof settingsEventSchema>
