export type StoredDevice = {
  id: string
  name: string
  endpoint: string
  endpoints?: string[]
  token: string
  pairedDeviceId?: string
  lastConnectedAt?: number
}

export type PairingPayload = {
  version: number
  deviceId: string
  deviceName: string
  endpoint: string
  endpoints?: string[]
  pairingId?: string
  oneTimeSecret?: string
  expiresAt?: number
  token?: string
}

export type RemoteInfo = {
  deviceId: string
  deviceName: string
  version?: number
  serverVersion?: string
  endpoint?: string
  endpoints?: string[]
  latencyMs?: number
}

export type VideoItem = {
  id: string
  name: string
  fileName?: string
  extension: string
  size: number
  modified?: number
  group?: string
  tags?: string[]
  systemTags?: string[]
  customTags?: string[]
  favorite?: boolean
  directoryId?: string
  directoryName?: string
  thumbnailUrl: string
  thumbnailToken?: string
  streamUrl: string
}

export type DirectorySummary = {
  id: string
  name: string
  count: number
}

export type CategorySummary = {
  key: string
  name: string
  count: number
  type: 'custom' | 'system'
}

export type LibraryResponse = {
  items: VideoItem[]
  count: number
  directories?: DirectorySummary[]
  categoryGroups?: {
    custom: CategorySummary[]
    system: CategorySummary[]
  }
  favoriteCount?: number
  scannedAt?: number
}

export type PlaybackState = {
  position: number
  updatedAt?: number
}

export type VideoAnalysisTimelineItem = {
  start_time: number
  end_time: number
  title?: string
  description?: string
  confidence?: number
  vlm_status?: string
}

export type VideoAnalysisCharacter = {
  name?: string
  identity_status?: string
  description?: string
  confidence?: number
}

export type VideoAnalysisResult = {
  available: boolean
  reason?: string
  error?: string
  savedAt?: string
  matchType?: string
  sourceVideo?: {
    original_filename?: string
    duration?: number
    file_size_bytes?: number
  }
  summary?: string
  tags?: string[]
  keywords?: string[]
  timeline?: VideoAnalysisTimelineItem[]
  characters?: VideoAnalysisCharacter[]
  quality?: Record<string, unknown>
  naming?: {
    episode_title?: string
    [key: string]: unknown
  }
}

export type VideoAnalysisEvent = {
  type?: string
  stage?: string
  status?: string
  message?: string
  createdAt?: string
}

export type VideoAnalysisJob = {
  running: boolean
  currentVideo: boolean
  jobId?: string
  startedAt?: number
  lastEvent?: VideoAnalysisEvent | null
}

export type VideoAnalysisRecentEvent = {
  jobId?: string
  status?: string
  message?: string
  error?: string
  updatedAt?: number
  event?: VideoAnalysisEvent | null
  analysis?: VideoAnalysisResult | null
}

export type VideoAnalysisResponse = {
  enabled: boolean
  analysis: VideoAnalysisResult | null
  job: VideoAnalysisJob | null
  recent: VideoAnalysisRecentEvent | null
  checkedAt: number
  accepted?: boolean
  reason?: string
  error?: string
}
