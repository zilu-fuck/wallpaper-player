import type { Capabilities } from '../../packages/contracts'
export type {
  PairingPayload, RemoteInfo, VideoItem, DirectorySummary, CategorySummary, LibraryResponse,
  PlaybackState, PlaybackWrite, VideoAnalysisTimelineItem, VideoAnalysisCharacter, VideoAnalysisResult,
  VideoAnalysisEvent, VideoAnalysisJob, VideoAnalysisRecentEvent, VideoAnalysisResponse
} from '../../packages/contracts'

export type StoredDevice = {
  bindingId?: string
  capabilities?: Partial<Capabilities>
  id: string
  name: string
  endpoint: string
  endpoints?: string[]
  token: string
  pairedDeviceId?: string
  lastConnectedAt?: number
}
