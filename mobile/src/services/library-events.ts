import type { VideoItem } from '../types'

type VideoLibraryPatch = Partial<Pick<VideoItem, 'favorite' | 'customTags' | 'tags' | 'group'>>

export type VideoLibraryUpdate = {
  deviceId: string
  videoId: string
  patch: VideoLibraryPatch
}

type Listener = (update: VideoLibraryUpdate) => void

const listeners = new Set<Listener>()

export function emitVideoLibraryUpdate(update: VideoLibraryUpdate) {
  listeners.forEach(listener => listener(update))
}

export function subscribeToVideoLibraryUpdates(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
