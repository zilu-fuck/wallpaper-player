import type { VideoItem } from '../types'
import { createSearchEntry, matchesLibraryQuery, tagKey } from '../../../packages/domain'
import type { SearchEntry } from '../../../packages/domain'

export type TagFilter = {
  key: string
  type: 'custom' | 'system'
  name: string
  state: 'include' | 'exclude'
}
export type LibraryScope = { mode: string, id?: string }
export type VideoSearchIndexEntry = SearchEntry
export const getTagKey = tagKey

export function createVideoSearchIndex(items: VideoItem[]) {
  return new Map(items.map(item => [item.id, createSearchEntry(item)]))
}
export function filterLibrary(items: VideoItem[], scope: LibraryScope, filters: TagFilter[], query: string,
  index = createVideoSearchIndex(items)) {
  const request = { directoryId: scope.mode === 'directory' ? scope.id : undefined,
    favorite: scope.mode === 'favorites' ? true : undefined, query, sort: 'name' as const,
    includeTags: filters.filter(filter => filter.state === 'include').map(({ type, name }) => ({ type, name })),
    excludeTags: filters.filter(filter => filter.state === 'exclude').map(({ type, name }) => ({ type, name })) }
  return items.filter(video => matchesLibraryQuery(video, request, index.get(video.id)))
}
