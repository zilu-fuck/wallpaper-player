import { type Infer } from './schema';
export declare const SETTINGS_MAP_FIELDS: readonly ["customTags", "customTagRevisions", "playbackStates"];
type JsonMap = Record<string, unknown>;
export type SettingsMapDelta = {
    set: JsonMap;
    removed: string[];
    order?: string[];
};
export declare function diffSettingsMap(previous: unknown, next: unknown, equality?: 'identity' | 'json'): SettingsMapDelta | null;
export declare function applySettingsMap(previous: unknown, delta: SettingsMapDelta): JsonMap;
export declare const settingsVersionSchema: import("./schema").Schema<{
    epoch: string;
    revision: number;
} & {}>;
export type SettingsVersion = Infer<typeof settingsVersionSchema>;
export declare const settingsReplyOptionsSchema: import("./schema").Schema<{
    settingsReply: "version-v1";
} & {}>;
export type SettingsReplyOptions = Infer<typeof settingsReplyOptionsSchema>;
export declare const settingsReadOptionsSchema: import("./schema").Schema<{
    encoding: "json-v1";
} & {}>;
export type SettingsReadOptions = Infer<typeof settingsReadOptionsSchema>;
export declare const settingsFeedSchema: import("./schema").Schema<{
    kind: "settings-feed-v1";
    feedId: string;
    snapshot: Record<string, unknown>;
} & {}>;
export declare const settingsLegacyListenerSchema: import("./schema").Schema<{
    enabled: boolean;
    sequence: number;
} & {
    encoding?: "json-v1" | undefined;
}>;
export declare const settingsEventSchema: import("./schema").Schema<({
    set: Record<string, unknown>;
    removed: string[];
    kind: "settings-patch-v1";
    feedId: string;
    baseVersion: {
        epoch: string;
        revision: number;
    } & {};
    version: {
        epoch: string;
        revision: number;
    } & {};
    maps: Record<string, {
        set: Record<string, unknown>;
        removed: string[];
    } & {
        order?: string[] | undefined;
    }>;
} & {}) | ({
    kind: "settings-snapshot-v1";
    feedId: string;
    snapshot: Record<string, unknown>;
} & {}) | ({
    kind: "settings-resync-v1";
    feedId: string;
    version: {
        epoch: string;
        revision: number;
    } & {};
} & {})>;
export type SettingsFeed = Infer<typeof settingsFeedSchema>;
export type SettingsEvent = Infer<typeof settingsEventSchema>;
export {};
