"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsEventSchema = exports.settingsLegacyListenerSchema = exports.settingsFeedSchema = exports.settingsReadOptionsSchema = exports.settingsReplyOptionsSchema = exports.settingsVersionSchema = exports.SETTINGS_MAP_FIELDS = void 0;
exports.diffSettingsMap = diffSettingsMap;
exports.applySettingsMap = applySettingsMap;
const schema_1 = require("./schema");
exports.SETTINGS_MAP_FIELDS = ['customTags', 'customTagRevisions', 'playbackStates'];
const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const own = (value, key, item) => Object.defineProperty(value, key, { value: item, enumerable: true, configurable: true, writable: true });
function diffSettingsMap(previous, next, equality = 'json') {
    if (!record(previous) || !record(next))
        return null;
    const set = Object.fromEntries(Object.entries(next).filter(([key, value]) => !Object.hasOwn(previous, key) ||
        (equality === 'identity' ? !Object.is(previous[key], value) : JSON.stringify(previous[key]) !== JSON.stringify(value))));
    const removed = Object.keys(previous).filter(key => !Object.hasOwn(next, key)), candidate = { ...previous };
    for (const key of removed)
        delete candidate[key];
    for (const [key, value] of Object.entries(set))
        own(candidate, key, value);
    const keys = Object.keys(next), natural = Object.keys(candidate);
    return { set, removed, ...(keys.some((key, index) => key !== natural[index]) ? { order: keys } : {}) };
}
function applySettingsMap(previous, delta) {
    if (!record(previous))
        throw new schema_1.ContractError('settings.map', '缺少有效基线');
    const next = { ...previous };
    for (const key of delta.removed)
        delete next[key];
    for (const [key, value] of Object.entries(delta.set))
        own(next, key, value);
    if (!delta.order)
        return next;
    if (delta.order.length !== Object.keys(next).length || new Set(delta.order).size !== delta.order.length ||
        delta.order.some(key => !Object.hasOwn(next, key)))
        throw new schema_1.ContractError('settings.map.order', '必须覆盖当前键且不重复');
    return Object.fromEntries(delta.order.map(key => [key, next[key]]));
}
exports.settingsVersionSchema = schema_1.s.object({ epoch: schema_1.s.string(128, 1), revision: schema_1.s.integer() });
exports.settingsReplyOptionsSchema = schema_1.s.object({ settingsReply: schema_1.s.literal('version-v1') });
exports.settingsReadOptionsSchema = schema_1.s.object({ encoding: schema_1.s.literal('json-v1') });
const snapshot = schema_1.s.refine(schema_1.s.record(schema_1.jsonSchema), value => {
    try {
        exports.settingsVersionSchema.parse(value._settingsVersion);
    }
    catch {
        return false;
    }
    return !Object.hasOwn(value, 'tagMutationReceipts') && record(value.privacy) &&
        typeof value.privacy.passwordSet === 'boolean' && Object.keys(value.privacy).every(key => key === 'passwordSet');
}, '必须包含版本及经过脱敏的设置');
exports.settingsFeedSchema = schema_1.s.object({ kind: schema_1.s.literal('settings-feed-v1'), feedId: schema_1.s.string(128, 1), snapshot });
exports.settingsLegacyListenerSchema = schema_1.s.object({ enabled: schema_1.s.boolean, sequence: schema_1.s.integer(), encoding: schema_1.s.optional(schema_1.s.literal('json-v1')) });
const key = schema_1.s.string(262144, 1), keys = schema_1.s.array(key, 200000);
const mapDelta = schema_1.s.object({ set: schema_1.s.record(schema_1.jsonSchema), removed: keys, order: schema_1.s.optional(keys) });
const patch = schema_1.s.refine(schema_1.s.object({ kind: schema_1.s.literal('settings-patch-v1'), feedId: schema_1.s.string(128, 1),
    baseVersion: exports.settingsVersionSchema, version: exports.settingsVersionSchema, set: schema_1.s.record(schema_1.jsonSchema), removed: keys, maps: schema_1.s.record(mapDelta) }), value => {
    const names = [...Object.keys(value.set), ...value.removed, ...Object.keys(value.maps)];
    if (new Set(names).size !== names.length || names.some(name => ['_settingsVersion', 'tagMutationReceipts'].includes(name)))
        return false;
    if (Object.keys(value.maps).some(name => !exports.SETTINGS_MAP_FIELDS.includes(name)))
        return false;
    if (Object.hasOwn(value.set, 'privacy') && (!record(value.set.privacy) || typeof value.set.privacy.passwordSet !== 'boolean' ||
        Object.keys(value.set.privacy).some(name => name !== 'passwordSet')))
        return false;
    return value.version.epoch === value.baseVersion.epoch && value.version.revision > value.baseVersion.revision;
}, '必须是同一世代的安全、无重叠设置增量');
exports.settingsEventSchema = schema_1.s.union(patch, schema_1.s.object({ kind: schema_1.s.literal('settings-snapshot-v1'), feedId: schema_1.s.string(128, 1), snapshot }), schema_1.s.object({ kind: schema_1.s.literal('settings-resync-v1'), feedId: schema_1.s.string(128, 1), version: exports.settingsVersionSchema }));
