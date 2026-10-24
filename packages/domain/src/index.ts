import type { CategorySummary, LibraryQuery, VideoItem } from '../../contracts'

export type QueryVideo = Pick<VideoItem, 'id' | 'name' | 'size'> & Partial<Omit<VideoItem, 'id' | 'name' | 'size'>>
export type SearchEntry = { searchText: string, customTagKeys: Set<string>, systemTagKeys: Set<string> }
export const tagKey = (value: string) => value.trim().toLowerCase()
export const categoryKey = (type: 'custom' | 'system', name: string) => `${type}:${tagKey(name)}`
export const normalizeCategoryKey = (value: string) => value.replace(/^(custom|system):(.+)$/, (_, type, name) => categoryKey(type, name))
export function createSearchEntry(video: QueryVideo): SearchEntry {
  const customTags = video.customTags || []
  const systemTags = video.systemTags ?? (video.tags || []).filter(tag => !customTags.includes(tag))
  return { searchText: [video.name, video.fileName, video.group, ...(video.tags || []), ...systemTags, ...customTags,
    video.directoryName, video.extension].filter(Boolean).join(' ').toLowerCase(),
    customTagKeys: new Set(customTags.map(tagKey)), systemTagKeys: new Set(systemTags.map(tagKey)) }
}
export function normalizeLibraryQuery(query: LibraryQuery): LibraryQuery {
  const normalizeTags = (tags: LibraryQuery['includeTags']) => [...new Map(tags.map(tag =>
    [`${tag.type}:${tagKey(tag.name)}`, { type: tag.type, name: tagKey(tag.name) }])).values()]
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`))
  return { ...query, query: query.query.trim().toLowerCase(), includeTags: normalizeTags(query.includeTags), excludeTags: normalizeTags(query.excludeTags) }
}
export function matchesLibraryQuery(video: QueryVideo, query: LibraryQuery, entry = createSearchEntry(video)) {
  if (query.directoryId && video.directoryId !== query.directoryId) return false
  if (query.favorite !== undefined && Boolean(video.favorite) !== query.favorite) return false
  for (const tag of query.includeTags) if (!(tag.type === 'custom' ? entry.customTagKeys : entry.systemTagKeys).has(tagKey(tag.name))) return false
  for (const tag of query.excludeTags) if ((tag.type === 'custom' ? entry.customTagKeys : entry.systemTagKeys).has(tagKey(tag.name))) return false
  return !query.query || entry.searchText.includes(query.query.trim().toLowerCase())
}
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
export function aggregateCategoryGroups(items: Array<Pick<QueryVideo, 'customTags' | 'systemTags' | 'tags'>>) {
  const groups = { custom: new Map<string, CategorySummary>(), system: new Map<string, CategorySummary>() }
  for (const item of items) {
    const tags = { custom: item.customTags || [], system: item.systemTags ?? (item.tags || []).filter(tag => !(item.customTags || []).includes(tag)) }
    for (const type of ['custom', 'system'] as const) {
      for (const [key, name] of new Map(tags[type].map(name => [categoryKey(type, name), name]))) {
        const previous = groups[type].get(key)
        groups[type].set(key, { key, name: previous?.name || name, type, count: (previous?.count || 0) + 1 })
      }
    }
  }
  const rows = (type: 'custom' | 'system') => [...groups[type].values()].sort((a, b) => b.count - a.count || collator.compare(a.name, b.name))
  return { custom: rows('custom'), system: rows('system') }
}
export function compareLibraryVideos(a: QueryVideo, b: QueryVideo, sort: LibraryQuery['sort']) {
  const title = () => collator.compare(a.name || a.fileName || '', b.name || b.fileName || '') ||
    collator.compare(a.fileName || '', b.fileName || '') || collator.compare(a.id, b.id)
  if (sort === 'date') return (b.modified || 0) - (a.modified || 0) || title()
  if (sort === 'size') return b.size - a.size || title()
  if (sort === 'type') return collator.compare(a.extension || '', b.extension || '') || title()
  return title()
}

export class LibraryQueryIndex<T extends QueryVideo = VideoItem> {
  readonly items: T[]
  private entries: SearchEntry[]
  private sorted = new Map<LibraryQuery['sort'], number[]>()
  private directories = new Map<string, Set<number>>()
  private customTags = new Map<string, Set<number>>()
  private systemTags = new Map<string, Set<number>>()
  private favorites = new Set<number>()
  private queryCache = new Map<string, number[]>()
  private cacheBytes = 0
  cacheHits = 0
  queries = 0
  constructor(items: T[], directoryMemberships?: Map<string, string[]>) {
    const directoryNames = new Map<string, Set<string>>()
    const inferredMemberships = new Map<string, string[]>()
    for (const item of items) {
      if (item.directoryName) {
        let names = directoryNames.get(item.id)
        if (!names) { names = new Set(); directoryNames.set(item.id, names) }
        names.add(item.directoryName)
      }
      if (item.directoryId) inferredMemberships.set(item.id, [...new Set([...(inferredMemberships.get(item.id) || []), item.directoryId])])
    }
    directoryMemberships ||= inferredMemberships
    this.items = [...new Map(items.map(item => [item.id, item])).values()]
    this.entries = this.items.map(item => createSearchEntry({ ...item, directoryName: [...(directoryNames.get(item.id) || [])].join(' ') }))
    const add = (map: Map<string, Set<number>>, key: string, index: number) => {
      let values = map.get(key); if (!values) { values = new Set(); map.set(key, values) } values.add(index)
    }
    this.items.forEach((item, index) => {
      const entry = this.entries[index]
      for (const key of entry.customTagKeys) add(this.customTags, key, index)
      for (const key of entry.systemTagKeys) add(this.systemTags, key, index)
      for (const directory of directoryMemberships?.get(item.id) || (item.directoryId ? [item.directoryId] : [])) add(this.directories, directory, index)
      if (item.favorite) this.favorites.add(index)
    })
  }
  matching(input: LibraryQuery): number[] {
    const query = normalizeLibraryQuery(input)
    const key = JSON.stringify(query)
    const cached = this.queryCache.get(key)
    if (cached) { this.cacheHits++; this.queryCache.delete(key); this.queryCache.set(key, cached); return cached }
    this.queries++
    let candidates: Set<number> | undefined
    const intersect = (next: Set<number>) => {
      candidates = candidates === undefined ? new Set(next) : new Set([...candidates].filter(index => next.has(index)))
    }
    if (query.directoryId) intersect(this.directories.get(query.directoryId) || new Set())
    if (query.favorite === true) intersect(this.favorites)
    for (const tag of query.includeTags) intersect((tag.type === 'custom' ? this.customTags : this.systemTags).get(tag.name) || new Set())
    const excluded = new Set<number>()
    if (query.favorite === false) for (const index of this.favorites) excluded.add(index)
    for (const tag of query.excludeTags) for (const index of (tag.type === 'custom' ? this.customTags : this.systemTags).get(tag.name) || []) excluded.add(index)
    let ordered = this.sorted.get(query.sort)
    if (!ordered) { ordered = this.items.map((_, index) => index).sort((a, b) => compareLibraryVideos(this.items[a], this.items[b], query.sort)); this.sorted.set(query.sort, ordered) }
    const result = ordered.filter(index => (!candidates || candidates.has(index)) && !excluded.has(index) &&
      (!query.query || this.entries[index].searchText.includes(query.query)))
    this.queryCache.set(key, result); this.cacheBytes += result.length * 8
    while (this.queryCache.size > 64 || this.cacheBytes > 8 * 1024 * 1024) {
      const oldest = this.queryCache.keys().next().value
      if (oldest === undefined) break
      this.cacheBytes -= (this.queryCache.get(oldest)?.length || 0) * 8; this.queryCache.delete(oldest)
    }
    return result
  }
  page(query: LibraryQuery, offset: number, limit: number) {
    const matching = this.matching(query)
    return { items: matching.slice(offset, offset + limit).map(index => this.items[index]), matchedCount: matching.length }
  }
  get favoriteCount() { return this.favorites.size }
  categoryGroups(): { custom: CategorySummary[], system: CategorySummary[] } {
    return aggregateCategoryGroups(this.items)
  }
}
