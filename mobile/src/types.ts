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
