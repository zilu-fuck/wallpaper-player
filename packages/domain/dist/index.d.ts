import type { CategorySummary, LibraryQuery, VideoItem } from '../../contracts';
export type QueryVideo = Pick<VideoItem, 'id' | 'name' | 'size'> & Partial<Omit<VideoItem, 'id' | 'name' | 'size'>>;
export type SearchEntry = {
    searchText: string;
    customTagKeys: Set<string>;
    systemTagKeys: Set<string>;
};
export declare const tagKey: (value: string) => string;
export declare const categoryKey: (type: "custom" | "system", name: string) => string;
export declare const normalizeCategoryKey: (value: string) => string;
export declare function createSearchEntry(video: QueryVideo): SearchEntry;
export declare function normalizeLibraryQuery(query: LibraryQuery): LibraryQuery;
export declare function matchesLibraryQuery(video: QueryVideo, query: LibraryQuery, entry?: SearchEntry): boolean;
export declare function aggregateCategoryGroups(items: Array<Pick<QueryVideo, 'customTags' | 'systemTags' | 'tags'>>): {
    custom: {
        key: string;
        name: string;
        count: number;
        type: "custom" | "system";
    }[];
    system: {
        key: string;
        name: string;
        count: number;
        type: "custom" | "system";
    }[];
};
export declare function compareLibraryVideos(a: QueryVideo, b: QueryVideo, sort: LibraryQuery['sort']): number;
export declare class LibraryQueryIndex<T extends QueryVideo = VideoItem> {
    readonly items: T[];
    private entries;
    private sorted;
    private directories;
    private customTags;
    private systemTags;
    private favorites;
    private queryCache;
    private cacheBytes;
    cacheHits: number;
    queries: number;
    constructor(items: T[], directoryMemberships?: Map<string, string[]>);
    matching(input: LibraryQuery): number[];
    page(query: LibraryQuery, offset: number, limit: number): {
        items: T[];
        matchedCount: number;
    };
    get favoriteCount(): number;
    categoryGroups(): {
        custom: CategorySummary[];
        system: CategorySummary[];
    };
}
