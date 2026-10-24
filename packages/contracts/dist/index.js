"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analysisRecentSchema = exports.analysisJobSchema = exports.analysisEventSchema = exports.analysisResultSchema = exports.transcodeCacheSchema = exports.tasksSchema = exports.ownedTaskSchema = exports.taskCancelSchema = exports.taskSchema = exports.versionedPlaybackResultSchema = exports.versionedPlaybackSchema = exports.playbackResultSchema = exports.bulkTagsDetailedSchema = exports.bulkTagsSchema = exports.mutationUpdatedSchema = exports.mutationFailureSchema = exports.bulkTagsRequestSchema = exports.versionedTagsResultSchema = exports.tagsResultSchema = exports.tagStateSchema = exports.tagsRequestSchema = exports.tagWriteSchema = exports.favoriteSchema = exports.favoriteRequestSchema = exports.successSchema = exports.playbackRequestSchema = exports.playbackWriteSchema = exports.playbackSchema = exports.categoriesPageSchema = exports.libraryRevisionSchema = exports.libraryPageSchema = exports.librarySchema = exports.libraryPageRequestSchema = exports.libraryQuerySchema = exports.queryTagSchema = exports.categorySchema = exports.directorySchema = exports.videoSchema = exports.mediaSchema = exports.pairingResultSchema = exports.pairingClaimSchema = exports.pairingPayloadSchema = exports.authorizationSchema = exports.infoSchema = exports.capabilitiesSchema = exports.MIN_CLIENT_PROTOCOL = exports.PROTOCOL_VERSION = exports.jsonSchema = exports.s = exports.ContractError = void 0;
exports.playerActionResultSchema = exports.playerNativeStateSchema = exports.playerActionSchema = exports.playerCommandSchema = exports.playerBoundsSchema = exports.metadataOptionsSchema = exports.mediaRequestIdSchema = exports.ipcScanSchema = exports.desktopVideoSchema = exports.ipcPlaybackSchema = exports.ipcPlaybackResultSchema = exports.ipcBulkTagsSchema = exports.ipcTagStateSchema = exports.legacyIpcTagsSchema = exports.ipcTagsSchema = exports.ipcFavoriteSchema = exports.ipcFailureSchema = exports.desktopPlaybackPatchSchema = exports.desktopTargetSchema = exports.qualitySchema = exports.errorEnvelopeSchema = exports.analysisCancelSchema = exports.ownedAnalysisSchema = exports.analysisSchema = void 0;
exports.negotiateCapabilities = negotiateCapabilities;
exports.isRetryableError = isRetryableError;
exports.errorDetails = errorDetails;
exports.validateHttpQuery = validateHttpQuery;
exports.getHttpContract = getHttpContract;
exports.parseMediaMutationArgs = parseMediaMutationArgs;
exports.mediaMutationResultSchema = mediaMutationResultSchema;
const schema_1 = require("./schema");
const settings_feed_1 = require("./settings-feed");
var schema_2 = require("./schema");
Object.defineProperty(exports, "ContractError", { enumerable: true, get: function () { return schema_2.ContractError; } });
Object.defineProperty(exports, "s", { enumerable: true, get: function () { return schema_2.s; } });
Object.defineProperty(exports, "jsonSchema", { enumerable: true, get: function () { return schema_2.jsonSchema; } });
__exportStar(require("./settings-feed"), exports);
exports.PROTOCOL_VERSION = 2;
exports.MIN_CLIENT_PROTOCOL = 1;
const optional = schema_1.s.optional;
const id = schema_1.s.string(1024, 1);
const locator = schema_1.s.string(65536, 1);
const text = schema_1.s.string(20000);
const tags = schema_1.s.array(schema_1.s.string(1024, 1), 500);
const nonnegative = schema_1.s.number(0);
const httpEndpoint = schema_1.s.refine(schema_1.s.string(16384, 1), value => /^https?:\/\//i.test(value), '必须是 HTTP 或 HTTPS 地址');
const mediaUrl = schema_1.s.refine(schema_1.s.string(32768), value => !value || value.startsWith('/v1/') || /^https?:\/\//i.test(value), '必须是支持的媒体地址');
exports.capabilitiesSchema = schema_1.s.object({
    favoriteState: schema_1.s.default(schema_1.s.boolean, false), mediaMutationResults: schema_1.s.default(schema_1.s.boolean, false),
    playbackRevision: schema_1.s.default(schema_1.s.boolean, false), libraryQuery: schema_1.s.default(schema_1.s.boolean, false),
    tagRevisions: schema_1.s.default(schema_1.s.boolean, false),
    authProbe: schema_1.s.default(schema_1.s.boolean, false),
    taskInterests: schema_1.s.default(schema_1.s.boolean, false),
    analysisInterests: schema_1.s.default(schema_1.s.boolean, false),
    libraryRevision: schema_1.s.default(schema_1.s.boolean, false), cursorPagination: schema_1.s.default(schema_1.s.boolean, false)
});
exports.infoSchema = schema_1.s.object({
    deviceId: id, deviceName: text, version: optional(schema_1.s.integer(1)), serverVersion: optional(text),
    protocolVersion: schema_1.s.default(schema_1.s.integer(1), 1), minClientProtocol: schema_1.s.default(schema_1.s.integer(1), 1),
    capabilities: schema_1.s.default(exports.capabilitiesSchema, exports.capabilitiesSchema.parse({})),
    endpoint: optional(httpEndpoint), endpoints: optional(schema_1.s.array(httpEndpoint, 32)), latencyMs: optional(nonnegative)
}, true);
exports.authorizationSchema = schema_1.s.object({ authorized: schema_1.s.literal(true), deviceId: id });
function negotiateCapabilities(info) {
    if (info.minClientProtocol > exports.PROTOCOL_VERSION) {
        const error = new schema_1.ContractError('protocolVersion', '低于电脑所需版本，请更新手机应用');
        error.code = 'unsupported_protocol';
        error.status = 426;
        throw error;
    }
    return info.capabilities;
}
exports.pairingPayloadSchema = schema_1.s.object({ version: schema_1.s.integer(1), deviceId: id, deviceName: text,
    endpoint: httpEndpoint, endpoints: optional(schema_1.s.array(httpEndpoint, 32)), pairingId: optional(id),
    oneTimeSecret: optional(id), expiresAt: optional(nonnegative), token: optional(id) }, true);
const pairingBase = { deviceId: id, deviceName: text, endpoint: optional(httpEndpoint), endpoints: optional(schema_1.s.array(httpEndpoint, 32)) };
exports.pairingClaimSchema = schema_1.s.object({ pairingId: id, oneTimeSecret: id,
    clientId: optional(schema_1.s.string(80, 1)), clientName: optional(schema_1.s.string(80)), platform: optional(schema_1.s.string(40)) });
exports.pairingResultSchema = schema_1.s.union(schema_1.s.object({ ...pairingBase, status: schema_1.s.literal('pending'), pairingRequestId: id, expiresAt: optional(nonnegative) }, true), schema_1.s.object({ ...pairingBase, status: optional(schema_1.s.literal('approved')), token: id, pairedDeviceId: optional(id), serverVersion: optional(text) }, true));
exports.mediaSchema = schema_1.s.object({ available: optional(schema_1.s.boolean), durationSeconds: optional(nonnegative),
    width: optional(nonnegative), height: optional(nonnegative), fps: optional(nonnegative), bitRate: optional(nonnegative),
    videoCodec: optional(text), audioCodec: optional(text), container: optional(text) }, true);
exports.videoSchema = schema_1.s.object({ id, name: text, fileName: optional(text),
    sourceType: optional(schema_1.s.enum(['local', 'network'])), resourceKind: optional(schema_1.s.enum(['direct', 'webpage'])),
    extension: text, size: nonnegative, modified: optional(nonnegative), group: optional(text),
    tags: optional(tags), systemTags: optional(tags), customTags: optional(tags), favorite: optional(schema_1.s.boolean),
    customTagsRevision: optional(schema_1.s.integer()),
    directoryId: optional(text), directoryName: optional(text), thumbnailUrl: mediaUrl,
    thumbnailToken: optional(text), streamUrl: mediaUrl, media: optional(schema_1.s.nullable(exports.mediaSchema)),
    network: optional(schema_1.s.nullable(schema_1.s.object({ site: optional(text), episodeIndex: optional(schema_1.s.nullable(nonnegative)),
        episodeTitle: optional(text), parser: optional(text), kind: optional(text) }, true))) }, true);
exports.directorySchema = schema_1.s.object({ id, name: text, count: schema_1.s.integer() });
exports.categorySchema = schema_1.s.object({ key: id, name: text, count: schema_1.s.integer(), type: schema_1.s.enum(['custom', 'system']) });
exports.queryTagSchema = schema_1.s.object({ type: schema_1.s.enum(['custom', 'system']), name: schema_1.s.string(1024, 1) });
exports.libraryQuerySchema = schema_1.s.object({ directoryId: optional(id), favorite: optional(schema_1.s.boolean),
    includeTags: schema_1.s.default(schema_1.s.array(exports.queryTagSchema, 32), []), excludeTags: schema_1.s.default(schema_1.s.array(exports.queryTagSchema, 32), []),
    query: schema_1.s.default(schema_1.s.string(1000), ''), sort: schema_1.s.default(schema_1.s.enum(['name', 'date', 'size', 'type']), 'name') });
exports.libraryPageRequestSchema = schema_1.s.object({ ...{
        directoryId: optional(id), favorite: optional(schema_1.s.boolean), includeTags: optional(schema_1.s.array(exports.queryTagSchema, 32)),
        excludeTags: optional(schema_1.s.array(exports.queryTagSchema, 32)), query: optional(schema_1.s.string(1000)),
        sort: optional(schema_1.s.enum(['name', 'date', 'size', 'type']))
    }, limit: schema_1.s.default(schema_1.s.integer(1, 500), 200), cursor: optional(schema_1.s.string(2048, 1)) });
exports.librarySchema = schema_1.s.object({ items: schema_1.s.array(exports.videoSchema), count: schema_1.s.integer(),
    directories: optional(schema_1.s.array(exports.directorySchema)), favoriteCount: optional(schema_1.s.integer()), hiddenTagCount: optional(schema_1.s.integer()),
    categoryGroups: optional(schema_1.s.object({ custom: schema_1.s.array(exports.categorySchema), system: schema_1.s.array(exports.categorySchema) })),
    pagination: optional(schema_1.s.object({ offset: schema_1.s.integer(), limit: schema_1.s.integer(), total: schema_1.s.integer(), returned: schema_1.s.integer(), hasMore: schema_1.s.boolean })),
    scannedAt: optional(nonnegative), indexed: optional(schema_1.s.boolean), refreshing: optional(schema_1.s.boolean),
    matchedCount: optional(schema_1.s.integer()), revision: optional(schema_1.s.string(120, 1)), nextCursor: optional(schema_1.s.nullable(schema_1.s.string(2048, 1))),
    aggregationScope: optional(schema_1.s.literal('visible-library')), scanState: optional(schema_1.s.enum(['ready', 'refreshing'])),
    categoryPagination: optional(schema_1.s.object({ customTotal: schema_1.s.integer(), systemTotal: schema_1.s.integer(),
        customNextCursor: schema_1.s.nullable(schema_1.s.string(2048, 1)), systemNextCursor: schema_1.s.nullable(schema_1.s.string(2048, 1)) })) }, true);
exports.libraryPageSchema = schema_1.s.refine(exports.librarySchema, value => value.revision !== undefined && value.matchedCount !== undefined &&
    value.nextCursor !== undefined && value.aggregationScope !== undefined, '缺少分页查询版本或匹配数量');
exports.libraryRevisionSchema = schema_1.s.object({ revision: schema_1.s.string(120, 1), count: schema_1.s.integer(), scanState: schema_1.s.enum(['ready', 'refreshing']) });
exports.categoriesPageSchema = schema_1.s.object({ items: schema_1.s.array(exports.categorySchema, 500), count: schema_1.s.integer(),
    nextCursor: schema_1.s.nullable(schema_1.s.string(2048, 1)), revision: schema_1.s.string(120, 1), aggregationScope: schema_1.s.literal('visible-library') });
exports.playbackSchema = schema_1.s.object({ position: nonnegative, updatedAt: optional(nonnegative), revision: optional(schema_1.s.integer()),
    writer: optional(schema_1.s.object({ session: schema_1.s.integer(1), sequence: schema_1.s.integer(1) })) }, true);
exports.playbackWriteSchema = schema_1.s.object({ baseRevision: schema_1.s.integer(), session: schema_1.s.integer(1), sequence: schema_1.s.integer(1) });
const playbackRequestBase = schema_1.s.object({ position: nonnegative, baseRevision: optional(schema_1.s.integer()),
    session: optional(schema_1.s.integer(1)), sequence: optional(schema_1.s.integer(1)) });
exports.playbackRequestSchema = schema_1.s.refine(playbackRequestBase, value => [value.baseRevision, value.session, value.sequence].every(item => item === undefined) ||
    [value.baseRevision, value.session, value.sequence].every(item => item !== undefined), '播放进度版本必须完整');
exports.successSchema = schema_1.s.object({ success: schema_1.s.boolean }, true);
exports.favoriteRequestSchema = schema_1.s.object({ favorite: optional(schema_1.s.boolean) });
exports.favoriteSchema = schema_1.s.object({ success: schema_1.s.boolean, favorite: schema_1.s.boolean }, true);
exports.tagWriteSchema = schema_1.s.object({ expectedRevision: schema_1.s.integer(), operationId: schema_1.s.string(120, 1) });
exports.tagsRequestSchema = schema_1.s.refine(schema_1.s.object({ tags: optional(tags), expectedRevision: optional(schema_1.s.integer()), operationId: optional(schema_1.s.string(120, 1)) }), value => (value.expectedRevision === undefined) === (value.operationId === undefined), '标签版本与操作编号必须完整');
exports.tagStateSchema = schema_1.s.object({ customTags: tags, customTagsRevision: schema_1.s.integer() }, true);
exports.tagsResultSchema = schema_1.s.object({ success: schema_1.s.boolean, customTags: tags, customTagsRevision: optional(schema_1.s.integer()),
    operationRevision: optional(schema_1.s.integer()), replayed: optional(schema_1.s.boolean) }, true);
exports.versionedTagsResultSchema = schema_1.s.refine(exports.tagsResultSchema, value => value.customTagsRevision !== undefined, '缺少标签版本');
exports.bulkTagsRequestSchema = schema_1.s.object({ videoIds: optional(schema_1.s.array(id, 10000)), tags: optional(tags) });
exports.mutationFailureSchema = schema_1.s.object({ id: optional(locator), index: schema_1.s.integer(), code: id, message: text });
exports.mutationUpdatedSchema = schema_1.s.object({ id: optional(locator), index: schema_1.s.integer(), customTags: tags, customTagsRevision: optional(schema_1.s.integer()) }, true);
exports.bulkTagsSchema = schema_1.s.refine(schema_1.s.object({ success: schema_1.s.boolean, updatedCount: schema_1.s.integer(), tags,
    updated: optional(schema_1.s.array(schema_1.s.object({ id, index: schema_1.s.integer(), customTags: tags, customTagsRevision: optional(schema_1.s.integer()) }), 10000)),
    failed: optional(schema_1.s.array(schema_1.s.object({ id, index: schema_1.s.integer(), code: id, message: text }), 10000)) }, true), value => !value.updated || value.updated.length === value.updatedCount, '批量结果数量不一致');
exports.bulkTagsDetailedSchema = schema_1.s.refine(exports.bulkTagsSchema, value => Array.isArray(value.updated) && Array.isArray(value.failed), '必须包含逐项成功和失败结果');
exports.playbackResultSchema = schema_1.s.object({ success: schema_1.s.boolean, playback: optional(exports.playbackSchema) }, true);
exports.versionedPlaybackSchema = schema_1.s.refine(exports.playbackSchema, value => value.revision !== undefined, '缺少播放进度版本');
exports.versionedPlaybackResultSchema = schema_1.s.refine(exports.playbackResultSchema, value => Boolean(value.playback && value.playback.revision !== undefined), '缺少已提交进度及版本');
exports.taskSchema = schema_1.s.object({ id: optional(id), quality: optional(text),
    status: schema_1.s.enum(['queued', 'running', 'ready', 'error', 'cancelled']), progress: schema_1.s.number(0, 1),
    error: optional(text), streamUrl: optional(mediaUrl), queuePosition: optional(schema_1.s.integer()),
    createdAt: optional(nonnegative), updatedAt: optional(nonnegative),
    interestId: optional(schema_1.s.string(128, 1)), canCancel: optional(schema_1.s.boolean), interestedClients: optional(schema_1.s.integer()),
    taskId: optional(id), operation: optional(schema_1.s.enum(['remux', 'reencode'])) }, true);
exports.taskCancelSchema = schema_1.s.object({ success: schema_1.s.boolean, released: optional(schema_1.s.boolean),
    taskCancelled: optional(schema_1.s.boolean), shared: optional(schema_1.s.boolean) }, true);
exports.ownedTaskSchema = schema_1.s.refine(exports.taskSchema, value => value.interestId !== undefined &&
    value.canCancel !== undefined && value.interestedClients !== undefined, '缺少任务订阅状态');
exports.tasksSchema = schema_1.s.object({ tasks: schema_1.s.array(exports.taskSchema, 10000), checkedAt: nonnegative });
exports.transcodeCacheSchema = schema_1.s.object({ success: schema_1.s.boolean, removed: schema_1.s.integer(), bytesRemoved: nonnegative,
    totalFiles: schema_1.s.integer(), totalBytes: nonnegative }, true);
exports.analysisResultSchema = schema_1.s.object({ available: schema_1.s.boolean, reason: optional(text), error: optional(text),
    savedAt: optional(text), matchType: optional(text), summary: optional(text), tags: optional(tags), keywords: optional(tags),
    sourceVideo: optional(schema_1.s.object({ original_filename: optional(text), duration: optional(nonnegative), file_size_bytes: optional(nonnegative) }, true)),
    timeline: optional(schema_1.s.array(schema_1.s.object({ start_time: nonnegative, end_time: nonnegative, title: optional(text), description: optional(text),
        confidence: optional(schema_1.s.number()), vlm_status: optional(text) }, true))),
    characters: optional(schema_1.s.array(schema_1.s.object({ name: optional(text), identity_status: optional(text), description: optional(text), confidence: optional(schema_1.s.number()) }, true))),
    quality: optional(schema_1.s.record(schema_1.jsonSchema)), naming: optional(schema_1.s.object({ episode_title: optional(text) }, true)) }, true);
exports.analysisEventSchema = schema_1.s.object({ type: optional(text), stage: optional(text), status: optional(text),
    message: optional(text), createdAt: optional(text) }, true);
exports.analysisJobSchema = schema_1.s.object({ running: schema_1.s.boolean, currentVideo: schema_1.s.boolean, jobId: optional(text),
    interestId: optional(schema_1.s.string(128, 1)), canCancel: optional(schema_1.s.boolean), interestedClients: optional(schema_1.s.integer()), interestCancelled: optional(schema_1.s.boolean),
    startedAt: optional(nonnegative), lastEvent: optional(schema_1.s.nullable(exports.analysisEventSchema)) }, true);
exports.analysisRecentSchema = schema_1.s.object({ jobId: optional(text), status: optional(text), message: optional(text), error: optional(text),
    updatedAt: optional(nonnegative), event: optional(schema_1.s.nullable(exports.analysisEventSchema)), analysis: optional(schema_1.s.nullable(exports.analysisResultSchema)) }, true);
exports.analysisSchema = schema_1.s.object({ enabled: schema_1.s.boolean, analysis: schema_1.s.nullable(exports.analysisResultSchema), job: schema_1.s.nullable(exports.analysisJobSchema),
    recent: schema_1.s.nullable(exports.analysisRecentSchema), checkedAt: nonnegative, accepted: optional(schema_1.s.boolean), reason: optional(text), error: optional(text) }, true);
exports.ownedAnalysisSchema = schema_1.s.refine(exports.analysisSchema, value => !value.job || (value.job.interestId !== undefined &&
    value.job.canCancel !== undefined && value.job.interestedClients !== undefined && value.job.interestCancelled !== undefined &&
    (!value.job.canCancel || (value.job.running && value.job.currentVideo && !value.job.interestCancelled && value.job.interestedClients > 0))), '分析订阅状态缺失或矛盾');
exports.analysisCancelSchema = schema_1.s.object({ success: schema_1.s.boolean, released: schema_1.s.boolean, taskCancelled: schema_1.s.boolean, shared: schema_1.s.boolean,
    cancelled: optional(schema_1.s.boolean), jobId: optional(text), reason: optional(text) }, true);
exports.errorEnvelopeSchema = schema_1.s.object({ error: schema_1.s.object({ code: id, message: text,
        retryable: optional(schema_1.s.boolean), currentRevision: optional(schema_1.s.integer()), currentLibraryRevision: optional(schema_1.s.string(120, 1)) }, true) });
function isRetryableError(status, code) {
    return !['invalid_response', 'unsupported_protocol'].includes(code) &&
        (code === 'network_error' || status === 408 || status === 429 || status >= 500);
}
function errorDetails(status, code, message, currentRevision, currentLibraryRevision) {
    return { code, message, retryable: isRetryableError(status, code),
        ...(currentRevision == null ? {} : { currentRevision }),
        ...(currentLibraryRevision == null ? {} : { currentLibraryRevision }) };
}
exports.qualitySchema = schema_1.s.enum(['compatible', '1080p', '720p', '480p']);
function validateHttpQuery(method, url) {
    if (method === 'GET' && url.pathname === '/v1/library') {
        for (const key of ['offset', 'limit']) {
            const value = url.searchParams.get(key);
            if (value != null)
                schema_1.s.integer().parse(Number(value), `query.${key}`);
        }
    }
    if (/^\/v1\/videos\/[^/]+\/(transcode|transcoded-stream)$/.test(url.pathname)) {
        exports.qualitySchema.parse((url.searchParams.get('quality') || 'compatible').trim().toLowerCase(), 'query.quality');
        if (url.searchParams.has('interestId'))
            schema_1.s.refine(schema_1.s.string(128, 1), value => /^[A-Za-z0-9_-]+$/.test(value), '任务订阅 ID 无效')
                .parse(url.searchParams.get('interestId'), 'query.interestId');
    }
}
function getHttpContract(method, pathname) {
    if (method === 'GET' && pathname === '/v1/info')
        return { response: exports.infoSchema };
    if (method === 'GET' && pathname === '/v1/auth')
        return { response: exports.authorizationSchema };
    if (method === 'POST' && pathname === '/v1/pairing/claim')
        return { request: exports.pairingClaimSchema, response: exports.pairingResultSchema };
    if (method === 'GET' && pathname === '/v1/library')
        return { response: exports.librarySchema };
    if (method === 'POST' && pathname === '/v1/library/query')
        return { request: exports.libraryPageRequestSchema, response: exports.libraryPageSchema };
    if (method === 'GET' && pathname === '/v1/library/revision')
        return { response: exports.libraryRevisionSchema };
    if (method === 'GET' && pathname === '/v1/library/categories')
        return { response: exports.categoriesPageSchema };
    if (method === 'GET' && /^\/v1\/playback\/[^/]+$/.test(pathname))
        return { response: schema_1.s.nullable(exports.versionedPlaybackSchema) };
    if (method === 'PUT' && /^\/v1\/playback\/[^/]+$/.test(pathname))
        return { request: exports.playbackRequestSchema, response: exports.versionedPlaybackResultSchema };
    if (method === 'PUT' && /^\/v1\/videos\/[^/]+\/favorite$/.test(pathname))
        return { request: exports.favoriteRequestSchema, response: exports.favoriteSchema };
    if (method === 'PUT' && pathname === '/v1/videos/tags/bulk')
        return { request: exports.bulkTagsRequestSchema, response: exports.bulkTagsDetailedSchema };
    if (method === 'PUT' && /^\/v1\/videos\/[^/]+\/tags$/.test(pathname))
        return { request: exports.tagsRequestSchema, response: exports.tagsResultSchema };
    if (method === 'GET' && /^\/v1\/videos\/[^/]+\/tags$/.test(pathname))
        return { response: exports.tagStateSchema };
    if (method === 'POST' && pathname === '/v1/tags/restore-hidden')
        return { request: schema_1.s.object({ password: optional(text) }), response: exports.successSchema };
    if (method === 'POST' && /^\/v1\/videos\/[^/]+\/play-on-desktop$/.test(pathname))
        return { request: schema_1.s.object({ position: optional(nonnegative) }), response: exports.successSchema };
    if (method === 'POST' && /^\/v1\/videos\/[^/]+\/reveal-on-desktop$/.test(pathname))
        return { response: exports.successSchema };
    if (method === 'DELETE' && pathname === '/v1/devices/current')
        return { response: exports.successSchema };
    if (/^\/v1\/videos\/[^/]+\/transcode$/.test(pathname))
        return { response: method === 'DELETE' ? exports.taskCancelSchema : exports.taskSchema };
    if (method === 'GET' && pathname === '/v1/transcodes')
        return { response: exports.tasksSchema };
    if (method === 'DELETE' && pathname === '/v1/transcodes/cache')
        return { request: schema_1.s.object({ force: optional(schema_1.s.boolean) }), response: exports.transcodeCacheSchema };
    if ((method === 'GET' || method === 'POST') && /^\/v1\/videos\/[^/]+\/analysis$/.test(pathname))
        return { response: exports.analysisSchema };
    if (method === 'DELETE' && /^\/v1\/videos\/[^/]+\/analysis$/.test(pathname))
        return { response: exports.analysisCancelSchema };
    if (method === 'GET' && /^\/v1\/videos\/[^/]+\/metadata$/.test(pathname))
        return { response: schema_1.s.object({ media: exports.mediaSchema, checkedAt: nonnegative }) };
    return undefined;
}
exports.desktopTargetSchema = schema_1.s.union(locator, schema_1.s.refine(schema_1.s.object({ id: optional(locator), fullPath: optional(locator), url: optional(locator),
    sourceType: optional(schema_1.s.enum(['local', 'network'])), favoriteKey: optional(locator) }, true), value => Boolean(value.id || value.fullPath || value.url), '缺少媒体目标'));
exports.desktopPlaybackPatchSchema = schema_1.s.object({ position: optional(nonnegative), updatedAt: optional(nonnegative), volume: optional(schema_1.s.number(0, 100)),
    speed: optional(schema_1.s.number(Number.MIN_VALUE)), muted: optional(schema_1.s.boolean), audioId: optional(schema_1.s.nullable(schema_1.s.number())), subtitleId: optional(schema_1.s.nullable(schema_1.s.number())),
    subtitleVisible: optional(schema_1.s.boolean), subtitleScale: optional(schema_1.s.number(Number.MIN_VALUE)), loopMode: optional(schema_1.s.enum(['off', 'inf', 'a-b'])),
    abLoopA: optional(schema_1.s.nullable(nonnegative)), abLoopB: optional(schema_1.s.nullable(nonnegative)) });
exports.ipcFailureSchema = schema_1.s.object({ success: schema_1.s.literal(false), error: text, code: optional(text), retryable: optional(schema_1.s.boolean), currentRevision: optional(schema_1.s.integer()) }, true);
const ipcSettings = { settings: optional(schema_1.s.record(schema_1.jsonSchema)), settingsVersion: optional(settings_feed_1.settingsVersionSchema) };
exports.ipcFavoriteSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true), favorite: schema_1.s.boolean, favoriteKey: optional(locator), ...ipcSettings }, true));
exports.ipcTagsSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true), customTags: tags, favoriteKey: optional(locator),
    customTagsRevision: schema_1.s.integer(), operationRevision: optional(schema_1.s.integer()), replayed: optional(schema_1.s.boolean), ...ipcSettings }, true));
exports.legacyIpcTagsSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true), customTags: tags, favoriteKey: optional(locator),
    customTagsRevision: optional(schema_1.s.integer()), operationRevision: optional(schema_1.s.integer()), replayed: optional(schema_1.s.boolean), ...ipcSettings }, true));
exports.ipcTagStateSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true), customTags: tags,
    customTagsRevision: schema_1.s.integer(), tagRevisionKey: optional(id), ...ipcSettings }, true));
exports.ipcBulkTagsSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true), updatedCount: schema_1.s.integer(), tags,
    updated: schema_1.s.array(exports.mutationUpdatedSchema, 10000), failed: schema_1.s.array(exports.mutationFailureSchema, 10000), ...ipcSettings }, true));
exports.ipcPlaybackResultSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true) }, true));
exports.ipcPlaybackSchema = schema_1.s.nullable(schema_1.s.object({ position: nonnegative, updatedAt: optional(nonnegative), volume: optional(schema_1.s.number(0, 100)),
    speed: optional(schema_1.s.number(Number.MIN_VALUE)), muted: optional(schema_1.s.boolean), revision: optional(schema_1.s.integer()) }, true));
exports.desktopVideoSchema = schema_1.s.object({ fullPath: locator, name: text, fileName: text, extension: text, size: nonnegative,
    favoriteKey: optional(locator), id: optional(locator), tags: optional(tags), group: optional(text), modified: optional(nonnegative) }, true);
exports.ipcScanSchema = schema_1.s.union(schema_1.s.object({ error: text }, true), schema_1.s.object({ videos: schema_1.s.array(exports.desktopVideoSchema),
    directory: optional(text), totalCount: optional(schema_1.s.integer()), indexed: optional(schema_1.s.boolean), refreshing: optional(schema_1.s.boolean) }, true));
const playerSessionId = schema_1.s.string(128, 1);
exports.mediaRequestIdSchema = schema_1.s.refine(schema_1.s.string(128, 1), value => /^[A-Za-z0-9_-]+$/.test(value), '媒体请求编号无效');
exports.metadataOptionsSchema = schema_1.s.object({ force: optional(schema_1.s.boolean), requestId: optional(exports.mediaRequestIdSchema) });
exports.playerBoundsSchema = schema_1.s.object({ x: schema_1.s.number(-100000, 100000), y: schema_1.s.number(-100000, 100000),
    width: schema_1.s.number(1, 100000), height: schema_1.s.number(1, 100000) });
exports.playerCommandSchema = schema_1.s.union(schema_1.s.object({ command: schema_1.s.enum(['seekTo', 'seekRelative', 'setVolume', 'setSpeed', 'setSubtitleScale']), value: schema_1.s.number() }), schema_1.s.object({ command: schema_1.s.enum(['setPaused', 'setMuted', 'setSubtitleVisible']), value: schema_1.s.boolean }), schema_1.s.object({ command: schema_1.s.enum(['setAudioTrack', 'setSubtitleTrack']), value: schema_1.s.union(schema_1.s.number(), schema_1.s.literal('no'), schema_1.s.literal('auto'), schema_1.s.literal('off'), schema_1.s.literal(null)) }), schema_1.s.object({ command: schema_1.s.literal('setLoopMode'), value: schema_1.s.enum(['off', 'inf', 'a-b']) }), schema_1.s.object({ command: schema_1.s.literal('setABLoop'), start: nonnegative, end: nonnegative }), schema_1.s.object({ command: schema_1.s.enum(['cyclePause', 'toggleMute', 'cycleSpeed', 'cycleAudioTrack', 'cycleSubtitleTrack',
        'toggleSubtitleVisible', 'clearABLoop', 'screenshot']) }));
exports.playerActionSchema = schema_1.s.union(schema_1.s.object({ action: schema_1.s.literal('load'), sessionId: playerSessionId, target: locator, source: schema_1.s.enum(['local', 'network']),
    resume: optional(schema_1.s.boolean), hostBounds: optional(exports.playerBoundsSchema), title: optional(text),
    temporary: optional(schema_1.s.boolean), kind: optional(schema_1.s.enum(['direct', 'webpage'])),
    playlist: optional(schema_1.s.array(locator, 10000)), playlistIndex: optional(schema_1.s.integer(0, 9999)) }), schema_1.s.object({ action: schema_1.s.enum(['stop', 'state']), sessionId: playerSessionId }), schema_1.s.object({ action: schema_1.s.literal('bounds'), sessionId: playerSessionId, bounds: exports.playerBoundsSchema }), schema_1.s.object({ action: schema_1.s.literal('command'), sessionId: playerSessionId, command: exports.playerCommandSchema }));
exports.playerNativeStateSchema = schema_1.s.object({ filePath: schema_1.s.nullable(locator), resourceTarget: optional(locator),
    sessionId: schema_1.s.string(128), engineSessionId: schema_1.s.integer(), timePos: nonnegative, duration: nonnegative,
    paused: schema_1.s.boolean, ready: schema_1.s.boolean, volume: schema_1.s.number(0, 100), muted: schema_1.s.boolean, speed: schema_1.s.number(Number.MIN_VALUE),
    eofReached: schema_1.s.boolean, buffering: schema_1.s.default(schema_1.s.boolean, false), trackList: schema_1.s.array(schema_1.s.record(schema_1.jsonSchema), 1000) }, true);
exports.playerActionResultSchema = schema_1.s.union(exports.ipcFailureSchema, schema_1.s.object({ success: schema_1.s.literal(true), sessionId: playerSessionId,
    state: optional(exports.playerNativeStateSchema), screenshotPath: optional(locator), webpageUrl: optional(httpEndpoint) }, true));
function parseMediaMutationArgs(method, args) {
    if (method === 'getVideoTags')
        return [exports.desktopTargetSchema.parse(args[0])];
    if (method === 'setFavorite')
        return [exports.desktopTargetSchema.parse(args[0]), optional(schema_1.s.boolean).parse(args[1])];
    if (method === 'setVideoTags')
        return [exports.desktopTargetSchema.parse(args[0]), tags.parse(args[1]), optional(exports.tagWriteSchema).parse(args[2])];
    if (method === 'appendTagsBulk')
        return [schema_1.s.array(exports.desktopTargetSchema, 10000).parse(args[0]), tags.parse(args[1])];
    throw new schema_1.ContractError('method', '不受支持');
}
function mediaMutationResultSchema(method) {
    if (method === 'getVideoTags')
        return exports.ipcTagStateSchema;
    if (method === 'setFavorite')
        return exports.ipcFavoriteSchema;
    if (method === 'setVideoTags')
        return exports.ipcTagsSchema;
    if (method === 'appendTagsBulk')
        return exports.ipcBulkTagsSchema;
    throw new schema_1.ContractError('method', '不受支持');
}
