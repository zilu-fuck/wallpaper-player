import { setVideoFavorite, savePlaybackState, setVideoCustomTags } from '../../src/api/media'
import type { PlaybackState, VideoItem } from '../../packages/contracts'

// These checks fail CI if generated DTOs or real adapters become untyped.
setVideoFavorite({ fullPath: 'C:/fixture.mp4' }, true)
savePlaybackState('C:/fixture.mp4', { position: 0, volume: 0 })
setVideoCustomTags({ fullPath: 'C:/fixture.mp4' }, ['tag'], { expectedRevision: 0, operationId: 'tag-operation' })
// @ts-expect-error tag revision must be numeric
setVideoCustomTags({ fullPath: 'C:/fixture.mp4' }, ['tag'], { expectedRevision: '0', operationId: 'tag-operation' })
// @ts-expect-error favorite state must be a boolean
setVideoFavorite({ fullPath: 'C:/fixture.mp4' }, 'true')
// @ts-expect-error position is a number in both the shared DTO and the adapter
savePlaybackState('C:/fixture.mp4', { position: '0' })
// @ts-expect-error shared mobile playback DTO cannot accept a string
const playback: PlaybackState = { position: '0' }
// @ts-expect-error local desktop paths are not a mobile media DTO
const video: VideoItem = { fullPath: 'C:/fixture.mp4' }
void playback
void video
