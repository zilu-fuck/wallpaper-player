import { type Infer, type Schema } from './schema';
export { ContractError, s, jsonSchema } from './schema';
export type { Infer, Schema } from './schema';
export * from './settings-feed';
export declare const PROTOCOL_VERSION = 2;
export declare const MIN_CLIENT_PROTOCOL = 1;
export declare const capabilitiesSchema: Schema<{
    favoriteState: boolean;
    mediaMutationResults: boolean;
    playbackRevision: boolean;
    libraryQuery: boolean;
    tagRevisions: boolean;
    authProbe: boolean;
    taskInterests: boolean;
    analysisInterests: boolean;
    libraryRevision: boolean;
    cursorPagination: boolean;
} & {}>;
export type Capabilities = Infer<typeof capabilitiesSchema>;
export declare const infoSchema: Schema<{
    deviceId: string;
    deviceName: string;
    protocolVersion: number;
    minClientProtocol: number;
    capabilities: {
        favoriteState: boolean;
        mediaMutationResults: boolean;
        playbackRevision: boolean;
        libraryQuery: boolean;
        tagRevisions: boolean;
        authProbe: boolean;
        taskInterests: boolean;
        analysisInterests: boolean;
        libraryRevision: boolean;
        cursorPagination: boolean;
    } & {};
} & {
    version?: number | undefined;
    serverVersion?: string | undefined;
    endpoint?: string | undefined;
    endpoints?: string[] | undefined;
    latencyMs?: number | undefined;
}>;
export type RemoteInfo = Infer<typeof infoSchema>;
export declare const authorizationSchema: Schema<{
    deviceId: string;
    authorized: true;
} & {}>;
export declare function negotiateCapabilities(info: RemoteInfo): Capabilities;
export declare const pairingPayloadSchema: Schema<{
    version: number;
    deviceId: string;
    deviceName: string;
    endpoint: string;
} & {
    endpoints?: string[] | undefined;
    pairingId?: string | undefined;
    oneTimeSecret?: string | undefined;
    expiresAt?: number | undefined;
    token?: string | undefined;
}>;
export type PairingPayload = Infer<typeof pairingPayloadSchema>;
export declare const pairingClaimSchema: Schema<{
    pairingId: string;
    oneTimeSecret: string;
} & {
    clientId?: string | undefined;
    clientName?: string | undefined;
    platform?: string | undefined;
}>;
export declare const pairingResultSchema: Schema<({
    deviceId: string;
    deviceName: string;
    status: "pending";
    pairingRequestId: string;
} & {
    endpoint?: string | undefined;
    endpoints?: string[] | undefined;
    expiresAt?: number | undefined;
}) | ({
    deviceId: string;
    deviceName: string;
    token: string;
} & {
    serverVersion?: string | undefined;
    endpoint?: string | undefined;
    endpoints?: string[] | undefined;
    status?: "approved" | undefined;
    pairedDeviceId?: string | undefined;
})>;
export declare const mediaSchema: Schema<{} & {
    available?: boolean | undefined;
    durationSeconds?: number | undefined;
    width?: number | undefined;
    height?: number | undefined;
    fps?: number | undefined;
    bitRate?: number | undefined;
    videoCodec?: string | undefined;
    audioCodec?: string | undefined;
    container?: string | undefined;
}>;
export declare const videoSchema: Schema<{
    id: string;
    name: string;
    extension: string;
    size: number;
    thumbnailUrl: string;
    streamUrl: string;
} & {
    customTags?: string[] | undefined;
    fileName?: string | undefined;
    sourceType?: "local" | "network" | undefined;
    network?: ({} & {
        kind?: string | undefined;
        site?: string | undefined;
        episodeIndex?: number | null | undefined;
        episodeTitle?: string | undefined;
        parser?: string | undefined;
    }) | null | undefined;
    resourceKind?: "direct" | "webpage" | undefined;
    modified?: number | undefined;
    group?: string | undefined;
    tags?: string[] | undefined;
    systemTags?: string[] | undefined;
    favorite?: boolean | undefined;
    customTagsRevision?: number | undefined;
    directoryId?: string | undefined;
    directoryName?: string | undefined;
    thumbnailToken?: string | undefined;
    media?: ({} & {
        available?: boolean | undefined;
        durationSeconds?: number | undefined;
        width?: number | undefined;
        height?: number | undefined;
        fps?: number | undefined;
        bitRate?: number | undefined;
        videoCodec?: string | undefined;
        audioCodec?: string | undefined;
        container?: string | undefined;
    }) | null | undefined;
}>;
export type VideoItem = Infer<typeof videoSchema>;
export declare const directorySchema: Schema<{
    id: string;
    name: string;
    count: number;
} & {}>;
export type DirectorySummary = Infer<typeof directorySchema>;
export declare const categorySchema: Schema<{
    key: string;
    name: string;
    count: number;
    type: "custom" | "system";
} & {}>;
export type CategorySummary = Infer<typeof categorySchema>;
export declare const queryTagSchema: Schema<{
    name: string;
    type: "custom" | "system";
} & {}>;
export declare const libraryQuerySchema: Schema<{
    sort: "name" | "size" | "type" | "date";
    includeTags: ({
        name: string;
        type: "custom" | "system";
    } & {})[];
    excludeTags: ({
        name: string;
        type: "custom" | "system";
    } & {})[];
    query: string;
} & {
    favorite?: boolean | undefined;
    directoryId?: string | undefined;
}>;
export type LibraryQuery = Infer<typeof libraryQuerySchema>;
export declare const libraryPageRequestSchema: Schema<{
    limit: number;
} & {
    sort?: "name" | "size" | "type" | "date" | undefined;
    favorite?: boolean | undefined;
    directoryId?: string | undefined;
    includeTags?: ({
        name: string;
        type: "custom" | "system";
    } & {})[] | undefined;
    excludeTags?: ({
        name: string;
        type: "custom" | "system";
    } & {})[] | undefined;
    query?: string | undefined;
    cursor?: string | undefined;
}>;
export type LibraryPageRequest = Infer<typeof libraryPageRequestSchema>;
export declare const librarySchema: Schema<{
    count: number;
    items: ({
        id: string;
        name: string;
        extension: string;
        size: number;
        thumbnailUrl: string;
        streamUrl: string;
    } & {
        customTags?: string[] | undefined;
        fileName?: string | undefined;
        sourceType?: "local" | "network" | undefined;
        network?: ({} & {
            kind?: string | undefined;
            site?: string | undefined;
            episodeIndex?: number | null | undefined;
            episodeTitle?: string | undefined;
            parser?: string | undefined;
        }) | null | undefined;
        resourceKind?: "direct" | "webpage" | undefined;
        modified?: number | undefined;
        group?: string | undefined;
        tags?: string[] | undefined;
        systemTags?: string[] | undefined;
        favorite?: boolean | undefined;
        customTagsRevision?: number | undefined;
        directoryId?: string | undefined;
        directoryName?: string | undefined;
        thumbnailToken?: string | undefined;
        media?: ({} & {
            available?: boolean | undefined;
            durationSeconds?: number | undefined;
            width?: number | undefined;
            height?: number | undefined;
            fps?: number | undefined;
            bitRate?: number | undefined;
            videoCodec?: string | undefined;
            audioCodec?: string | undefined;
            container?: string | undefined;
        }) | null | undefined;
    })[];
} & {
    revision?: string | undefined;
    directories?: ({
        id: string;
        name: string;
        count: number;
    } & {})[] | undefined;
    favoriteCount?: number | undefined;
    hiddenTagCount?: number | undefined;
    categoryGroups?: ({
        custom: ({
            key: string;
            name: string;
            count: number;
            type: "custom" | "system";
        } & {})[];
        system: ({
            key: string;
            name: string;
            count: number;
            type: "custom" | "system";
        } & {})[];
    } & {}) | undefined;
    pagination?: ({
        limit: number;
        offset: number;
        total: number;
        returned: number;
        hasMore: boolean;
    } & {}) | undefined;
    scannedAt?: number | undefined;
    indexed?: boolean | undefined;
    refreshing?: boolean | undefined;
    matchedCount?: number | undefined;
    nextCursor?: string | null | undefined;
    aggregationScope?: "visible-library" | undefined;
    scanState?: "refreshing" | "ready" | undefined;
    categoryPagination?: ({
        customTotal: number;
        systemTotal: number;
        customNextCursor: string | null;
        systemNextCursor: string | null;
    } & {}) | undefined;
}>;
export type LibraryResponse = Infer<typeof librarySchema>;
export declare const libraryPageSchema: Schema<{
    count: number;
    items: ({
        id: string;
        name: string;
        extension: string;
        size: number;
        thumbnailUrl: string;
        streamUrl: string;
    } & {
        customTags?: string[] | undefined;
        fileName?: string | undefined;
        sourceType?: "local" | "network" | undefined;
        network?: ({} & {
            kind?: string | undefined;
            site?: string | undefined;
            episodeIndex?: number | null | undefined;
            episodeTitle?: string | undefined;
            parser?: string | undefined;
        }) | null | undefined;
        resourceKind?: "direct" | "webpage" | undefined;
        modified?: number | undefined;
        group?: string | undefined;
        tags?: string[] | undefined;
        systemTags?: string[] | undefined;
        favorite?: boolean | undefined;
        customTagsRevision?: number | undefined;
        directoryId?: string | undefined;
        directoryName?: string | undefined;
        thumbnailToken?: string | undefined;
        media?: ({} & {
            available?: boolean | undefined;
            durationSeconds?: number | undefined;
            width?: number | undefined;
            height?: number | undefined;
            fps?: number | undefined;
            bitRate?: number | undefined;
            videoCodec?: string | undefined;
            audioCodec?: string | undefined;
            container?: string | undefined;
        }) | null | undefined;
    })[];
} & {
    revision?: string | undefined;
    directories?: ({
        id: string;
        name: string;
        count: number;
    } & {})[] | undefined;
    favoriteCount?: number | undefined;
    hiddenTagCount?: number | undefined;
    categoryGroups?: ({
        custom: ({
            key: string;
            name: string;
            count: number;
            type: "custom" | "system";
        } & {})[];
        system: ({
            key: string;
            name: string;
            count: number;
            type: "custom" | "system";
        } & {})[];
    } & {}) | undefined;
    pagination?: ({
        limit: number;
        offset: number;
        total: number;
        returned: number;
        hasMore: boolean;
    } & {}) | undefined;
    scannedAt?: number | undefined;
    indexed?: boolean | undefined;
    refreshing?: boolean | undefined;
    matchedCount?: number | undefined;
    nextCursor?: string | null | undefined;
    aggregationScope?: "visible-library" | undefined;
    scanState?: "refreshing" | "ready" | undefined;
    categoryPagination?: ({
        customTotal: number;
        systemTotal: number;
        customNextCursor: string | null;
        systemNextCursor: string | null;
    } & {}) | undefined;
}>;
export declare const libraryRevisionSchema: Schema<{
    revision: string;
    count: number;
    scanState: "refreshing" | "ready";
} & {}>;
export declare const categoriesPageSchema: Schema<{
    revision: string;
    count: number;
    items: ({
        key: string;
        name: string;
        count: number;
        type: "custom" | "system";
    } & {})[];
    nextCursor: string | null;
    aggregationScope: "visible-library";
} & {}>;
export declare const playbackSchema: Schema<{
    position: number;
} & {
    revision?: number | undefined;
    updatedAt?: number | undefined;
    writer?: ({
        sequence: number;
        session: number;
    } & {}) | undefined;
}>;
export type PlaybackState = Infer<typeof playbackSchema>;
export declare const playbackWriteSchema: Schema<{
    sequence: number;
    session: number;
    baseRevision: number;
} & {}>;
export type PlaybackWrite = Infer<typeof playbackWriteSchema>;
export declare const playbackRequestSchema: Schema<{
    position: number;
} & {
    sequence?: number | undefined;
    session?: number | undefined;
    baseRevision?: number | undefined;
}>;
export declare const successSchema: Schema<{
    success: boolean;
} & {}>;
export declare const favoriteRequestSchema: Schema<{} & {
    favorite?: boolean | undefined;
}>;
export declare const favoriteSchema: Schema<{
    favorite: boolean;
    success: boolean;
} & {}>;
export declare const tagWriteSchema: Schema<{
    expectedRevision: number;
    operationId: string;
} & {}>;
export type TagWrite = Infer<typeof tagWriteSchema>;
export declare const tagsRequestSchema: Schema<{} & {
    tags?: string[] | undefined;
    expectedRevision?: number | undefined;
    operationId?: string | undefined;
}>;
export declare const tagStateSchema: Schema<{
    customTags: string[];
    customTagsRevision: number;
} & {}>;
export declare const tagsResultSchema: Schema<{
    customTags: string[];
    success: boolean;
} & {
    customTagsRevision?: number | undefined;
    operationRevision?: number | undefined;
    replayed?: boolean | undefined;
}>;
export declare const versionedTagsResultSchema: Schema<{
    customTags: string[];
    success: boolean;
} & {
    customTagsRevision?: number | undefined;
    operationRevision?: number | undefined;
    replayed?: boolean | undefined;
}>;
export declare const bulkTagsRequestSchema: Schema<{} & {
    tags?: string[] | undefined;
    videoIds?: string[] | undefined;
}>;
export declare const mutationFailureSchema: Schema<{
    index: number;
    code: string;
    message: string;
} & {
    id?: string | undefined;
}>;
export declare const mutationUpdatedSchema: Schema<{
    customTags: string[];
    index: number;
} & {
    id?: string | undefined;
    customTagsRevision?: number | undefined;
}>;
export declare const bulkTagsSchema: Schema<{
    tags: string[];
    success: boolean;
    updatedCount: number;
} & {
    updated?: ({
        customTags: string[];
        id: string;
        index: number;
    } & {
        customTagsRevision?: number | undefined;
    })[] | undefined;
    failed?: ({
        id: string;
        index: number;
        code: string;
        message: string;
    } & {})[] | undefined;
}>;
export type BulkTagsResult = Infer<typeof bulkTagsSchema>;
export declare const bulkTagsDetailedSchema: Schema<{
    tags: string[];
    success: boolean;
    updatedCount: number;
} & {
    updated?: ({
        customTags: string[];
        id: string;
        index: number;
    } & {
        customTagsRevision?: number | undefined;
    })[] | undefined;
    failed?: ({
        id: string;
        index: number;
        code: string;
        message: string;
    } & {})[] | undefined;
}>;
export declare const playbackResultSchema: Schema<{
    success: boolean;
} & {
    playback?: ({
        position: number;
    } & {
        revision?: number | undefined;
        updatedAt?: number | undefined;
        writer?: ({
            sequence: number;
            session: number;
        } & {}) | undefined;
    }) | undefined;
}>;
export declare const versionedPlaybackSchema: Schema<{
    position: number;
} & {
    revision?: number | undefined;
    updatedAt?: number | undefined;
    writer?: ({
        sequence: number;
        session: number;
    } & {}) | undefined;
}>;
export declare const versionedPlaybackResultSchema: Schema<{
    success: boolean;
} & {
    playback?: ({
        position: number;
    } & {
        revision?: number | undefined;
        updatedAt?: number | undefined;
        writer?: ({
            sequence: number;
            session: number;
        } & {}) | undefined;
    }) | undefined;
}>;
export declare const taskSchema: Schema<{
    status: "ready" | "queued" | "running" | "error" | "cancelled";
    progress: number;
} & {
    id?: string | undefined;
    streamUrl?: string | undefined;
    updatedAt?: number | undefined;
    quality?: string | undefined;
    error?: string | undefined;
    queuePosition?: number | undefined;
    createdAt?: number | undefined;
    interestId?: string | undefined;
    canCancel?: boolean | undefined;
    interestedClients?: number | undefined;
    taskId?: string | undefined;
    operation?: "remux" | "reencode" | undefined;
}>;
export type TaskStatus = Infer<typeof taskSchema>;
export declare const taskCancelSchema: Schema<{
    success: boolean;
} & {
    released?: boolean | undefined;
    taskCancelled?: boolean | undefined;
    shared?: boolean | undefined;
}>;
export declare const ownedTaskSchema: Schema<{
    status: "ready" | "queued" | "running" | "error" | "cancelled";
    progress: number;
} & {
    id?: string | undefined;
    streamUrl?: string | undefined;
    updatedAt?: number | undefined;
    quality?: string | undefined;
    error?: string | undefined;
    queuePosition?: number | undefined;
    createdAt?: number | undefined;
    interestId?: string | undefined;
    canCancel?: boolean | undefined;
    interestedClients?: number | undefined;
    taskId?: string | undefined;
    operation?: "remux" | "reencode" | undefined;
}>;
export declare const tasksSchema: Schema<{
    tasks: ({
        status: "ready" | "queued" | "running" | "error" | "cancelled";
        progress: number;
    } & {
        id?: string | undefined;
        streamUrl?: string | undefined;
        updatedAt?: number | undefined;
        quality?: string | undefined;
        error?: string | undefined;
        queuePosition?: number | undefined;
        createdAt?: number | undefined;
        interestId?: string | undefined;
        canCancel?: boolean | undefined;
        interestedClients?: number | undefined;
        taskId?: string | undefined;
        operation?: "remux" | "reencode" | undefined;
    })[];
    checkedAt: number;
} & {}>;
export declare const transcodeCacheSchema: Schema<{
    removed: number;
    success: boolean;
    bytesRemoved: number;
    totalFiles: number;
    totalBytes: number;
} & {}>;
export declare const analysisResultSchema: Schema<{
    available: boolean;
} & {
    tags?: string[] | undefined;
    quality?: Record<string, unknown> | undefined;
    error?: string | undefined;
    reason?: string | undefined;
    savedAt?: string | undefined;
    matchType?: string | undefined;
    summary?: string | undefined;
    keywords?: string[] | undefined;
    sourceVideo?: ({} & {
        original_filename?: string | undefined;
        duration?: number | undefined;
        file_size_bytes?: number | undefined;
    }) | undefined;
    timeline?: ({
        start_time: number;
        end_time: number;
    } & {
        title?: string | undefined;
        description?: string | undefined;
        confidence?: number | undefined;
        vlm_status?: string | undefined;
    })[] | undefined;
    characters?: ({} & {
        name?: string | undefined;
        description?: string | undefined;
        confidence?: number | undefined;
        identity_status?: string | undefined;
    })[] | undefined;
    naming?: ({} & {
        episode_title?: string | undefined;
    }) | undefined;
}>;
export declare const analysisEventSchema: Schema<{} & {
    status?: string | undefined;
    type?: string | undefined;
    message?: string | undefined;
    createdAt?: string | undefined;
    stage?: string | undefined;
}>;
export declare const analysisJobSchema: Schema<{
    running: boolean;
    currentVideo: boolean;
} & {
    interestId?: string | undefined;
    canCancel?: boolean | undefined;
    interestedClients?: number | undefined;
    jobId?: string | undefined;
    interestCancelled?: boolean | undefined;
    startedAt?: number | undefined;
    lastEvent?: ({} & {
        status?: string | undefined;
        type?: string | undefined;
        message?: string | undefined;
        createdAt?: string | undefined;
        stage?: string | undefined;
    }) | null | undefined;
}>;
export declare const analysisRecentSchema: Schema<{} & {
    status?: string | undefined;
    updatedAt?: number | undefined;
    message?: string | undefined;
    error?: string | undefined;
    jobId?: string | undefined;
    event?: ({} & {
        status?: string | undefined;
        type?: string | undefined;
        message?: string | undefined;
        createdAt?: string | undefined;
        stage?: string | undefined;
    }) | null | undefined;
    analysis?: ({
        available: boolean;
    } & {
        tags?: string[] | undefined;
        quality?: Record<string, unknown> | undefined;
        error?: string | undefined;
        reason?: string | undefined;
        savedAt?: string | undefined;
        matchType?: string | undefined;
        summary?: string | undefined;
        keywords?: string[] | undefined;
        sourceVideo?: ({} & {
            original_filename?: string | undefined;
            duration?: number | undefined;
            file_size_bytes?: number | undefined;
        }) | undefined;
        timeline?: ({
            start_time: number;
            end_time: number;
        } & {
            title?: string | undefined;
            description?: string | undefined;
            confidence?: number | undefined;
            vlm_status?: string | undefined;
        })[] | undefined;
        characters?: ({} & {
            name?: string | undefined;
            description?: string | undefined;
            confidence?: number | undefined;
            identity_status?: string | undefined;
        })[] | undefined;
        naming?: ({} & {
            episode_title?: string | undefined;
        }) | undefined;
    }) | null | undefined;
}>;
export declare const analysisSchema: Schema<{
    enabled: boolean;
    checkedAt: number;
    analysis: ({
        available: boolean;
    } & {
        tags?: string[] | undefined;
        quality?: Record<string, unknown> | undefined;
        error?: string | undefined;
        reason?: string | undefined;
        savedAt?: string | undefined;
        matchType?: string | undefined;
        summary?: string | undefined;
        keywords?: string[] | undefined;
        sourceVideo?: ({} & {
            original_filename?: string | undefined;
            duration?: number | undefined;
            file_size_bytes?: number | undefined;
        }) | undefined;
        timeline?: ({
            start_time: number;
            end_time: number;
        } & {
            title?: string | undefined;
            description?: string | undefined;
            confidence?: number | undefined;
            vlm_status?: string | undefined;
        })[] | undefined;
        characters?: ({} & {
            name?: string | undefined;
            description?: string | undefined;
            confidence?: number | undefined;
            identity_status?: string | undefined;
        })[] | undefined;
        naming?: ({} & {
            episode_title?: string | undefined;
        }) | undefined;
    }) | null;
    job: ({
        running: boolean;
        currentVideo: boolean;
    } & {
        interestId?: string | undefined;
        canCancel?: boolean | undefined;
        interestedClients?: number | undefined;
        jobId?: string | undefined;
        interestCancelled?: boolean | undefined;
        startedAt?: number | undefined;
        lastEvent?: ({} & {
            status?: string | undefined;
            type?: string | undefined;
            message?: string | undefined;
            createdAt?: string | undefined;
            stage?: string | undefined;
        }) | null | undefined;
    }) | null;
    recent: ({} & {
        status?: string | undefined;
        updatedAt?: number | undefined;
        message?: string | undefined;
        error?: string | undefined;
        jobId?: string | undefined;
        event?: ({} & {
            status?: string | undefined;
            type?: string | undefined;
            message?: string | undefined;
            createdAt?: string | undefined;
            stage?: string | undefined;
        }) | null | undefined;
        analysis?: ({
            available: boolean;
        } & {
            tags?: string[] | undefined;
            quality?: Record<string, unknown> | undefined;
            error?: string | undefined;
            reason?: string | undefined;
            savedAt?: string | undefined;
            matchType?: string | undefined;
            summary?: string | undefined;
            keywords?: string[] | undefined;
            sourceVideo?: ({} & {
                original_filename?: string | undefined;
                duration?: number | undefined;
                file_size_bytes?: number | undefined;
            }) | undefined;
            timeline?: ({
                start_time: number;
                end_time: number;
            } & {
                title?: string | undefined;
                description?: string | undefined;
                confidence?: number | undefined;
                vlm_status?: string | undefined;
            })[] | undefined;
            characters?: ({} & {
                name?: string | undefined;
                description?: string | undefined;
                confidence?: number | undefined;
                identity_status?: string | undefined;
            })[] | undefined;
            naming?: ({} & {
                episode_title?: string | undefined;
            }) | undefined;
        }) | null | undefined;
    }) | null;
} & {
    error?: string | undefined;
    reason?: string | undefined;
    accepted?: boolean | undefined;
}>;
export declare const ownedAnalysisSchema: Schema<{
    enabled: boolean;
    checkedAt: number;
    analysis: ({
        available: boolean;
    } & {
        tags?: string[] | undefined;
        quality?: Record<string, unknown> | undefined;
        error?: string | undefined;
        reason?: string | undefined;
        savedAt?: string | undefined;
        matchType?: string | undefined;
        summary?: string | undefined;
        keywords?: string[] | undefined;
        sourceVideo?: ({} & {
            original_filename?: string | undefined;
            duration?: number | undefined;
            file_size_bytes?: number | undefined;
        }) | undefined;
        timeline?: ({
            start_time: number;
            end_time: number;
        } & {
            title?: string | undefined;
            description?: string | undefined;
            confidence?: number | undefined;
            vlm_status?: string | undefined;
        })[] | undefined;
        characters?: ({} & {
            name?: string | undefined;
            description?: string | undefined;
            confidence?: number | undefined;
            identity_status?: string | undefined;
        })[] | undefined;
        naming?: ({} & {
            episode_title?: string | undefined;
        }) | undefined;
    }) | null;
    job: ({
        running: boolean;
        currentVideo: boolean;
    } & {
        interestId?: string | undefined;
        canCancel?: boolean | undefined;
        interestedClients?: number | undefined;
        jobId?: string | undefined;
        interestCancelled?: boolean | undefined;
        startedAt?: number | undefined;
        lastEvent?: ({} & {
            status?: string | undefined;
            type?: string | undefined;
            message?: string | undefined;
            createdAt?: string | undefined;
            stage?: string | undefined;
        }) | null | undefined;
    }) | null;
    recent: ({} & {
        status?: string | undefined;
        updatedAt?: number | undefined;
        message?: string | undefined;
        error?: string | undefined;
        jobId?: string | undefined;
        event?: ({} & {
            status?: string | undefined;
            type?: string | undefined;
            message?: string | undefined;
            createdAt?: string | undefined;
            stage?: string | undefined;
        }) | null | undefined;
        analysis?: ({
            available: boolean;
        } & {
            tags?: string[] | undefined;
            quality?: Record<string, unknown> | undefined;
            error?: string | undefined;
            reason?: string | undefined;
            savedAt?: string | undefined;
            matchType?: string | undefined;
            summary?: string | undefined;
            keywords?: string[] | undefined;
            sourceVideo?: ({} & {
                original_filename?: string | undefined;
                duration?: number | undefined;
                file_size_bytes?: number | undefined;
            }) | undefined;
            timeline?: ({
                start_time: number;
                end_time: number;
            } & {
                title?: string | undefined;
                description?: string | undefined;
                confidence?: number | undefined;
                vlm_status?: string | undefined;
            })[] | undefined;
            characters?: ({} & {
                name?: string | undefined;
                description?: string | undefined;
                confidence?: number | undefined;
                identity_status?: string | undefined;
            })[] | undefined;
            naming?: ({} & {
                episode_title?: string | undefined;
            }) | undefined;
        }) | null | undefined;
    }) | null;
} & {
    error?: string | undefined;
    reason?: string | undefined;
    accepted?: boolean | undefined;
}>;
export declare const analysisCancelSchema: Schema<{
    success: boolean;
    released: boolean;
    taskCancelled: boolean;
    shared: boolean;
} & {
    cancelled?: boolean | undefined;
    reason?: string | undefined;
    jobId?: string | undefined;
}>;
export type VideoAnalysisResult = Infer<typeof analysisResultSchema>;
export type VideoAnalysisTimelineItem = NonNullable<VideoAnalysisResult['timeline']>[number];
export type VideoAnalysisCharacter = NonNullable<VideoAnalysisResult['characters']>[number];
export type VideoAnalysisEvent = Infer<typeof analysisEventSchema>;
export type VideoAnalysisJob = Infer<typeof analysisJobSchema>;
export type VideoAnalysisRecentEvent = Infer<typeof analysisRecentSchema>;
export type VideoAnalysisResponse = Infer<typeof analysisSchema>;
export declare const errorEnvelopeSchema: Schema<{
    error: {
        code: string;
        message: string;
    } & {
        retryable?: boolean | undefined;
        currentRevision?: number | undefined;
        currentLibraryRevision?: string | undefined;
    };
} & {}>;
export type ServiceError = Infer<typeof errorEnvelopeSchema>['error'];
export declare function isRetryableError(status: number, code: string): boolean;
export declare function errorDetails(status: number, code: string, message: string, currentRevision?: number, currentLibraryRevision?: string): ServiceError;
export declare const qualitySchema: Schema<"compatible" | "1080p" | "720p" | "480p">;
export declare function validateHttpQuery(method: string, url: URL): void;
export interface HttpContract {
    request?: Schema<unknown>;
    response: Schema<unknown>;
}
export declare function getHttpContract(method: string, pathname: string): HttpContract | undefined;
export declare const desktopTargetSchema: Schema<string | ({} & {
    id?: string | undefined;
    sourceType?: "local" | "network" | undefined;
    fullPath?: string | undefined;
    url?: string | undefined;
    favoriteKey?: string | undefined;
})>;
export type MediaMutationTarget = Infer<typeof desktopTargetSchema>;
export declare const desktopPlaybackPatchSchema: Schema<{} & {
    position?: number | undefined;
    updatedAt?: number | undefined;
    volume?: number | undefined;
    speed?: number | undefined;
    muted?: boolean | undefined;
    audioId?: number | null | undefined;
    subtitleId?: number | null | undefined;
    subtitleVisible?: boolean | undefined;
    subtitleScale?: number | undefined;
    loopMode?: "off" | "inf" | "a-b" | undefined;
    abLoopA?: number | null | undefined;
    abLoopB?: number | null | undefined;
}>;
export type DesktopPlaybackPatch = Infer<typeof desktopPlaybackPatchSchema>;
export declare const ipcFailureSchema: Schema<{
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}>;
export declare const ipcFavoriteSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    favorite: boolean;
    success: true;
} & {
    favoriteKey?: string | undefined;
    settings?: Record<string, unknown> | undefined;
    settingsVersion?: ({
        epoch: string;
        revision: number;
    } & {}) | undefined;
})>;
export declare const ipcTagsSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    customTags: string[];
    customTagsRevision: number;
    success: true;
} & {
    operationRevision?: number | undefined;
    replayed?: boolean | undefined;
    favoriteKey?: string | undefined;
    settings?: Record<string, unknown> | undefined;
    settingsVersion?: ({
        epoch: string;
        revision: number;
    } & {}) | undefined;
})>;
export declare const legacyIpcTagsSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    customTags: string[];
    success: true;
} & {
    customTagsRevision?: number | undefined;
    operationRevision?: number | undefined;
    replayed?: boolean | undefined;
    favoriteKey?: string | undefined;
    settings?: Record<string, unknown> | undefined;
    settingsVersion?: ({
        epoch: string;
        revision: number;
    } & {}) | undefined;
})>;
export declare const ipcTagStateSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    customTags: string[];
    customTagsRevision: number;
    success: true;
} & {
    settings?: Record<string, unknown> | undefined;
    settingsVersion?: ({
        epoch: string;
        revision: number;
    } & {}) | undefined;
    tagRevisionKey?: string | undefined;
})>;
export declare const ipcBulkTagsSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    tags: string[];
    success: true;
    updatedCount: number;
    updated: ({
        customTags: string[];
        index: number;
    } & {
        id?: string | undefined;
        customTagsRevision?: number | undefined;
    })[];
    failed: ({
        index: number;
        code: string;
        message: string;
    } & {
        id?: string | undefined;
    })[];
} & {
    settings?: Record<string, unknown> | undefined;
    settingsVersion?: ({
        epoch: string;
        revision: number;
    } & {}) | undefined;
})>;
export declare const ipcPlaybackResultSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    success: true;
} & {})>;
export declare const ipcPlaybackSchema: Schema<({
    position: number;
} & {
    revision?: number | undefined;
    updatedAt?: number | undefined;
    volume?: number | undefined;
    speed?: number | undefined;
    muted?: boolean | undefined;
}) | null>;
export declare const desktopVideoSchema: Schema<{
    name: string;
    fileName: string;
    extension: string;
    size: number;
    fullPath: string;
} & {
    id?: string | undefined;
    modified?: number | undefined;
    group?: string | undefined;
    tags?: string[] | undefined;
    favoriteKey?: string | undefined;
}>;
export declare const ipcScanSchema: Schema<({
    error: string;
} & {}) | ({
    videos: ({
        name: string;
        fileName: string;
        extension: string;
        size: number;
        fullPath: string;
    } & {
        id?: string | undefined;
        modified?: number | undefined;
        group?: string | undefined;
        tags?: string[] | undefined;
        favoriteKey?: string | undefined;
    })[];
} & {
    indexed?: boolean | undefined;
    refreshing?: boolean | undefined;
    directory?: string | undefined;
    totalCount?: number | undefined;
})>;
export declare const mediaRequestIdSchema: Schema<string>;
export declare const metadataOptionsSchema: Schema<{} & {
    force?: boolean | undefined;
    requestId?: string | undefined;
}>;
export declare const playerBoundsSchema: Schema<{
    width: number;
    height: number;
    x: number;
    y: number;
} & {}>;
export declare const playerCommandSchema: Schema<({
    value: number;
    command: "seekTo" | "seekRelative" | "setVolume" | "setSpeed" | "setSubtitleScale";
} & {}) | ({
    value: boolean;
    command: "setPaused" | "setMuted" | "setSubtitleVisible";
} & {}) | ({
    value: number | "off" | "no" | "auto" | null;
    command: "setAudioTrack" | "setSubtitleTrack";
} & {}) | ({
    value: "off" | "inf" | "a-b";
    command: "setLoopMode";
} & {}) | ({
    command: "setABLoop";
    start: number;
    end: number;
} & {}) | ({
    command: "cyclePause" | "toggleMute" | "cycleSpeed" | "cycleAudioTrack" | "cycleSubtitleTrack" | "toggleSubtitleVisible" | "clearABLoop" | "screenshot";
} & {})>;
export type PlayerCommand = Infer<typeof playerCommandSchema>;
export declare const playerActionSchema: Schema<({
    action: "load";
    sessionId: string;
    target: string;
    source: "local" | "network";
} & {
    kind?: "direct" | "webpage" | undefined;
    title?: string | undefined;
    resume?: boolean | undefined;
    hostBounds?: ({
        width: number;
        height: number;
        x: number;
        y: number;
    } & {}) | undefined;
    temporary?: boolean | undefined;
    playlist?: string[] | undefined;
    playlistIndex?: number | undefined;
}) | ({
    action: "stop" | "state";
    sessionId: string;
} & {}) | ({
    action: "bounds";
    sessionId: string;
    bounds: {
        width: number;
        height: number;
        x: number;
        y: number;
    } & {};
} & {}) | ({
    command: ({
        value: number;
        command: "seekTo" | "seekRelative" | "setVolume" | "setSpeed" | "setSubtitleScale";
    } & {}) | ({
        value: boolean;
        command: "setPaused" | "setMuted" | "setSubtitleVisible";
    } & {}) | ({
        value: number | "off" | "no" | "auto" | null;
        command: "setAudioTrack" | "setSubtitleTrack";
    } & {}) | ({
        value: "off" | "inf" | "a-b";
        command: "setLoopMode";
    } & {}) | ({
        command: "setABLoop";
        start: number;
        end: number;
    } & {}) | ({
        command: "cyclePause" | "toggleMute" | "cycleSpeed" | "cycleAudioTrack" | "cycleSubtitleTrack" | "toggleSubtitleVisible" | "clearABLoop" | "screenshot";
    } & {});
    action: "command";
    sessionId: string;
} & {})>;
export type PlayerAction = Infer<typeof playerActionSchema>;
export declare const playerNativeStateSchema: Schema<{
    ready: boolean;
    duration: number;
    volume: number;
    speed: number;
    muted: boolean;
    sessionId: string;
    filePath: string | null;
    engineSessionId: number;
    timePos: number;
    paused: boolean;
    eofReached: boolean;
    buffering: boolean;
    trackList: Record<string, unknown>[];
} & {
    resourceTarget?: string | undefined;
}>;
export type PlayerNativeState = Infer<typeof playerNativeStateSchema>;
export declare const playerActionResultSchema: Schema<({
    success: false;
    error: string;
} & {
    code?: string | undefined;
    retryable?: boolean | undefined;
    currentRevision?: number | undefined;
}) | ({
    success: true;
    sessionId: string;
} & {
    state?: ({
        ready: boolean;
        duration: number;
        volume: number;
        speed: number;
        muted: boolean;
        sessionId: string;
        filePath: string | null;
        engineSessionId: number;
        timePos: number;
        paused: boolean;
        eofReached: boolean;
        buffering: boolean;
        trackList: Record<string, unknown>[];
    } & {
        resourceTarget?: string | undefined;
    }) | undefined;
    screenshotPath?: string | undefined;
    webpageUrl?: string | undefined;
})>;
export type PlayerActionResult = Infer<typeof playerActionResultSchema>;
export declare function parseMediaMutationArgs(method: string, args: unknown[]): unknown[];
export declare function mediaMutationResultSchema(method: string): Schema<unknown>;
