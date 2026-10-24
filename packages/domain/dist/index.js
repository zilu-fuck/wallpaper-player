"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LibraryQueryIndex = exports.normalizeCategoryKey = exports.categoryKey = exports.tagKey = void 0;
exports.createSearchEntry = createSearchEntry;
exports.normalizeLibraryQuery = normalizeLibraryQuery;
exports.matchesLibraryQuery = matchesLibraryQuery;
exports.aggregateCategoryGroups = aggregateCategoryGroups;
exports.compareLibraryVideos = compareLibraryVideos;
const tagKey = (value) => value.trim().toLowerCase();
exports.tagKey = tagKey;
const categoryKey = (type, name) => `${type}:${(0, exports.tagKey)(name)}`;
exports.categoryKey = categoryKey;
const normalizeCategoryKey = (value) => value.replace(/^(custom|system):(.+)$/, (_, type, name) => (0, exports.categoryKey)(type, name));
exports.normalizeCategoryKey = normalizeCategoryKey;
function createSearchEntry(video) {
    const customTags = video.customTags || [];
    const systemTags = video.systemTags ?? (video.tags || []).filter(tag => !customTags.includes(tag));
    return { searchText: [video.name, video.fileName, video.group, ...(video.tags || []), ...systemTags, ...customTags,
            video.directoryName, video.extension].filter(Boolean).join(' ').toLowerCase(),
        customTagKeys: new Set(customTags.map(exports.tagKey)), systemTagKeys: new Set(systemTags.map(exports.tagKey)) };
}
function normalizeLibraryQuery(query) {
    const normalizeTags = (tags) => [...new Map(tags.map(tag => [`${tag.type}:${(0, exports.tagKey)(tag.name)}`, { type: tag.type, name: (0, exports.tagKey)(tag.name) }])).values()]
        .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
    return { ...query, query: query.query.trim().toLowerCase(), includeTags: normalizeTags(query.includeTags), excludeTags: normalizeTags(query.excludeTags) };
}
function matchesLibraryQuery(video, query, entry = createSearchEntry(video)) {
    if (query.directoryId && video.directoryId !== query.directoryId)
        return false;
    if (query.favorite !== undefined && Boolean(video.favorite) !== query.favorite)
        return false;
    for (const tag of query.includeTags)
        if (!(tag.type === 'custom' ? entry.customTagKeys : entry.systemTagKeys).has((0, exports.tagKey)(tag.name)))
            return false;
    for (const tag of query.excludeTags)
        if ((tag.type === 'custom' ? entry.customTagKeys : entry.systemTagKeys).has((0, exports.tagKey)(tag.name)))
            return false;
    return !query.query || entry.searchText.includes(query.query.trim().toLowerCase());
}
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
function aggregateCategoryGroups(items) {
    const groups = { custom: new Map(), system: new Map() };
    for (const item of items) {
        const tags = { custom: item.customTags || [], system: item.systemTags ?? (item.tags || []).filter(tag => !(item.customTags || []).includes(tag)) };
        for (const type of ['custom', 'system']) {
            for (const [key, name] of new Map(tags[type].map(name => [(0, exports.categoryKey)(type, name), name]))) {
                const previous = groups[type].get(key);
                groups[type].set(key, { key, name: previous?.name || name, type, count: (previous?.count || 0) + 1 });
            }
        }
    }
    const rows = (type) => [...groups[type].values()].sort((a, b) => b.count - a.count || collator.compare(a.name, b.name));
    return { custom: rows('custom'), system: rows('system') };
}
function compareLibraryVideos(a, b, sort) {
    const title = () => collator.compare(a.name || a.fileName || '', b.name || b.fileName || '') ||
        collator.compare(a.fileName || '', b.fileName || '') || collator.compare(a.id, b.id);
    if (sort === 'date')
        return (b.modified || 0) - (a.modified || 0) || title();
    if (sort === 'size')
        return b.size - a.size || title();
    if (sort === 'type')
        return collator.compare(a.extension || '', b.extension || '') || title();
    return title();
}
class LibraryQueryIndex {
    items;
    entries;
    sorted = new Map();
    directories = new Map();
    customTags = new Map();
    systemTags = new Map();
    favorites = new Set();
    queryCache = new Map();
    cacheBytes = 0;
    cacheHits = 0;
    queries = 0;
    constructor(items, directoryMemberships) {
        const directoryNames = new Map();
        const inferredMemberships = new Map();
        for (const item of items) {
            if (item.directoryName) {
                let names = directoryNames.get(item.id);
                if (!names) {
                    names = new Set();
                    directoryNames.set(item.id, names);
                }
                names.add(item.directoryName);
            }
            if (item.directoryId)
                inferredMemberships.set(item.id, [...new Set([...(inferredMemberships.get(item.id) || []), item.directoryId])]);
        }
        directoryMemberships ||= inferredMemberships;
        this.items = [...new Map(items.map(item => [item.id, item])).values()];
        this.entries = this.items.map(item => createSearchEntry({ ...item, directoryName: [...(directoryNames.get(item.id) || [])].join(' ') }));
        const add = (map, key, index) => {
            let values = map.get(key);
            if (!values) {
                values = new Set();
                map.set(key, values);
            }
            values.add(index);
        };
        this.items.forEach((item, index) => {
            const entry = this.entries[index];
            for (const key of entry.customTagKeys)
                add(this.customTags, key, index);
            for (const key of entry.systemTagKeys)
                add(this.systemTags, key, index);
            for (const directory of directoryMemberships?.get(item.id) || (item.directoryId ? [item.directoryId] : []))
                add(this.directories, directory, index);
            if (item.favorite)
                this.favorites.add(index);
        });
    }
    matching(input) {
        const query = normalizeLibraryQuery(input);
        const key = JSON.stringify(query);
        const cached = this.queryCache.get(key);
        if (cached) {
            this.cacheHits++;
            this.queryCache.delete(key);
            this.queryCache.set(key, cached);
            return cached;
        }
        this.queries++;
        let candidates;
        const intersect = (next) => {
            candidates = candidates === undefined ? new Set(next) : new Set([...candidates].filter(index => next.has(index)));
        };
        if (query.directoryId)
            intersect(this.directories.get(query.directoryId) || new Set());
        if (query.favorite === true)
            intersect(this.favorites);
        for (const tag of query.includeTags)
            intersect((tag.type === 'custom' ? this.customTags : this.systemTags).get(tag.name) || new Set());
        const excluded = new Set();
        if (query.favorite === false)
            for (const index of this.favorites)
                excluded.add(index);
        for (const tag of query.excludeTags)
            for (const index of (tag.type === 'custom' ? this.customTags : this.systemTags).get(tag.name) || [])
                excluded.add(index);
        let ordered = this.sorted.get(query.sort);
        if (!ordered) {
            ordered = this.items.map((_, index) => index).sort((a, b) => compareLibraryVideos(this.items[a], this.items[b], query.sort));
            this.sorted.set(query.sort, ordered);
        }
        const result = ordered.filter(index => (!candidates || candidates.has(index)) && !excluded.has(index) &&
            (!query.query || this.entries[index].searchText.includes(query.query)));
        this.queryCache.set(key, result);
        this.cacheBytes += result.length * 8;
        while (this.queryCache.size > 64 || this.cacheBytes > 8 * 1024 * 1024) {
            const oldest = this.queryCache.keys().next().value;
            if (oldest === undefined)
                break;
            this.cacheBytes -= (this.queryCache.get(oldest)?.length || 0) * 8;
            this.queryCache.delete(oldest);
        }
        return result;
    }
    page(query, offset, limit) {
        const matching = this.matching(query);
        return { items: matching.slice(offset, offset + limit).map(index => this.items[index]), matchedCount: matching.length };
    }
    get favoriteCount() { return this.favorites.size; }
    categoryGroups() {
        return aggregateCategoryGroups(this.items);
    }
}
exports.LibraryQueryIndex = LibraryQueryIndex;
