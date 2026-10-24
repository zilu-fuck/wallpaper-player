import { libraryQuerySchema, type LibraryQuery, type LibraryResponse } from '../../../packages/contracts'
import { LibraryQueryIndex, normalizeLibraryQuery } from '../../../packages/domain'
import type { StoredDevice } from '../types'
import { runWithCurrentDevice } from '../persistence/devices'
import { clearLibraryPageCache, readLibraryPageCache, writeLibraryPageCache } from '../persistence/library-pages'
import { clearCachedLibrary, loadCachedLibrary, saveLibraryResponse } from '../persistence/library'
import { ApiError, getLibrary, getLibraryCategories, getLibraryRevision, queryLibrary } from './api'

export const LIBRARY_PAGE_SIZE = 200
const MEMORY_BYTES = 8 * 1024 * 1024
const MEMORY_ENTRIES = 8
const emptyLibrary = (): LibraryResponse => ({ items: [], count: 0, directories: [], categoryGroups: { custom: [], system: [] }, favoriteCount: 0 })
export type LibraryState = { library: LibraryResponse, loading: boolean, loadingMore: boolean, offline: boolean,
  error: string, retryable: boolean, categoryLoading: 'custom' | 'system' | null }

/** Owns one visible library query. New queries abort and invalidate all older continuations. */
export class LibraryRepository {
  private device: StoredDevice
  private query = libraryQuerySchema.parse({})
  private key = ''
  private generation = 0
  private controller = new AbortController()
  private listeners = new Set<(state: LibraryState) => void>()
  private entries = new Map<string, { response: LibraryResponse, bytes: number }>()
  private bytes = 0
  private revision: string | undefined
  private revisionFlight: ReturnType<typeof getLibraryRevision> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private loadFlight: Promise<void> | null = null
  private pageFlight: Promise<void> | null = null
  private categoryFlight: Promise<void> | null = null
  private legacy: LibraryResponse | null = null
  private legacyIndex: LibraryQueryIndex | null = null
  private legacyItems: LibraryResponse['items'] | null = null
  private disposed = false
  private active = true
  state: LibraryState = { library: emptyLibrary(), loading: false, loadingMore: false, offline: false, error: '', retryable: true, categoryLoading: null }

  constructor(device: StoredDevice) { this.device = { ...device } }
  get paginated() { return Boolean(this.device.capabilities?.libraryQuery && this.device.capabilities?.cursorPagination && this.device.capabilities?.libraryRevision) }
  subscribe(listener: (state: LibraryState) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener) } }
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return
    this.active = active
    if (!active) { this.cancel(); this.publish({ loading: false, loadingMore: false, categoryLoading: null }) }
  }
  private publish(patch: Partial<LibraryState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener(this.state))
  }
  private valid(generation: number) { return !this.disposed && generation === this.generation }
  private async current(generation: number, device: StoredDevice) {
    if (!this.valid(generation)) return false
    const current = Boolean(await runWithCurrentDevice(device, async () => true))
    if (!this.valid(generation)) return false
    if (!current) {
      this.entries.clear(); this.bytes = 0; this.legacy = null; this.legacyIndex = null
      this.publish({ library: emptyLibrary(), error: '设备绑定已变更，请返回设备列表重新连接。', retryable: false, offline: false })
    }
    return current
  }
  private cache(key: string, response: LibraryResponse) {
    const bytes = JSON.stringify(response).length * 2
    this.bytes -= this.entries.get(key)?.bytes || 0; this.entries.delete(key)
    if (bytes <= MEMORY_BYTES) { this.entries.set(key, { response, bytes }); this.bytes += bytes }
    while (this.entries.size > MEMORY_ENTRIES || this.bytes > MEMORY_BYTES) {
      const first = this.entries.keys().next().value
      if (first === undefined) break
      this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first)
    }
  }
  private acceptRevision(revision?: string) {
    if (revision && revision !== this.revision) { this.entries.clear(); this.bytes = 0; this.revision = revision }
  }
  updateDevice(device: StoredDevice) {
    const mode = Boolean(device.capabilities?.libraryQuery && device.capabilities?.cursorPagination && device.capabilities?.libraryRevision)
    if (device.endpoint !== this.device.endpoint || mode !== this.paginated) { this.cancel(); this.key = '' }
    if (device.id !== this.device.id || device.bindingId !== this.device.bindingId || device.token !== this.device.token) {
      this.cancel(); this.entries.clear(); this.bytes = 0; this.legacy = null; this.legacyIndex = null; this.revision = undefined
      this.publish({ library: emptyLibrary(), error: '' })
    }
    this.device = { ...device }
  }
  private cancel() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.generation++; this.controller.abort(); this.controller = new AbortController()
    this.loadFlight = null; this.pageFlight = null; this.categoryFlight = null; this.revisionFlight = null
  }
  private scheduleRefresh() {
    if (this.disposed || !this.active || this.refreshTimer || !this.paginated || this.state.library.scanState !== 'refreshing') return
    const generation = this.generation
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.valid(generation)) void this.refresh()
    }, 1200)
  }
  private async failure(error: unknown, generation: number, device: StoredDevice) {
    if (!this.valid(generation) || (error instanceof Error && error.name === 'AbortError')) return
    if (!(error instanceof ApiError) || !error.retryable) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      this.entries.clear(); this.bytes = 0; this.legacy = null; this.legacyIndex = null
      await clearLibraryPageCache(device).catch(() => {})
      await clearCachedLibrary(device).catch(() => {})
      if (!this.valid(generation)) return
      this.publish({ library: emptyLibrary() })
    }
    this.publish({ error: error instanceof Error ? error.message : '视频库读取失败',
      retryable: error instanceof ApiError ? error.retryable : false,
      offline: error instanceof ApiError && (error.status === 0 || error.status === 408) })
  }
  async hydrate(input: Partial<LibraryQuery> = {}) {
    const query = normalizeLibraryQuery(libraryQuerySchema.parse(input)), key = JSON.stringify(query)
    const generation = this.generation, device = { ...this.device }
    const cached = this.paginated ? await readLibraryPageCache(device, key) : await loadCachedLibrary(device)
    if (!cached || !await this.current(generation, device)) return false
    this.publish({ library: this.paginated ? cached : this.legacyPage(cached, query), offline: true })
    return true
  }
  select(input: Partial<LibraryQuery> = {}, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    let query: LibraryQuery
    try { query = normalizeLibraryQuery(libraryQuerySchema.parse(input)) }
    catch {
      this.cancel(); this.publish({ library: emptyLibrary(), loading: false, loadingMore: false, categoryLoading: null,
        error: '筛选条件过长：搜索最多 1000 字，每类筛选最多 32 项。', retryable: false, offline: false })
      return Promise.resolve()
    }
    const key = JSON.stringify(query)
    if (!this.active) { if (key !== this.key) this.key = ''; this.query = query; return Promise.resolve() }
    if (!force && key === this.key && this.loadFlight) return this.loadFlight
    if (!force && key === this.key && this.state.library.items.length && !this.state.offline) return Promise.resolve()
    this.cancel(); this.query = query; this.key = key
    const generation = this.generation, device = { ...this.device }, signal = this.controller.signal
    const memory = this.entries.get(key)?.response
    this.publish({ library: emptyLibrary(), loading: true, loadingMore: false, categoryLoading: null, error: '', offline: false })
    const flight = (async () => {
      try {
        const cached = memory || (this.paginated ? await readLibraryPageCache(device, key) : await loadCachedLibrary(device))
        if (!this.valid(generation)) return
        if (cached && await this.current(generation, device) && (!this.revision || cached.revision === this.revision)) {
          const library = this.paginated ? cached : this.legacyPage(cached, query)
          this.publish({ library })
        }
        let response: LibraryResponse
        if (this.paginated) response = await queryLibrary(device, { ...query, limit: LIBRARY_PAGE_SIZE }, signal)
        else {
          this.legacy ||= await getLibrary(device, signal)
          response = this.legacyPage(this.legacy, query)
        }
        if (!await this.current(generation, device)) return
        if (this.paginated && cached && cached.revision === response.revision && cached.items.length > response.items.length) {
          const updated = new Map(response.items.map(item => [item.id, item]))
          response = { ...response, items: cached.items.map(item => updated.get(item.id) || item), nextCursor: cached.nextCursor,
            pagination: cached.pagination, categoryGroups: cached.categoryGroups, categoryPagination: cached.categoryPagination }
        }
        this.acceptRevision(response.revision); this.cache(key, response)
        this.publish({ library: response, offline: false })
        this.scheduleRefresh()
        if (this.paginated) await writeLibraryPageCache(device, key, response)
        else await saveLibraryResponse(device, this.legacy!)
      } catch (error) { await this.failure(error, generation, device) }
      finally { if (this.valid(generation)) { this.publish({ loading: false }); this.loadFlight = null } }
    })()
    this.loadFlight = flight
    return flight
  }
  private legacyPage(response: LibraryResponse, query: LibraryQuery): LibraryResponse {
    if (this.legacyItems !== response.items) { this.legacyItems = response.items; this.legacyIndex = new LibraryQueryIndex(response.items) }
    const items = this.legacyIndex!.page(query, 0, response.items.length).items
    return { ...response, count: this.legacyIndex!.items.length, favoriteCount: this.legacyIndex!.favoriteCount,
      categoryGroups: this.legacyIndex!.categoryGroups(), items, matchedCount: items.length, nextCursor: null,
      pagination: { offset: 0, limit: items.length, total: items.length, returned: items.length, hasMore: false } }
  }
  async refresh() {
    if (this.disposed || !this.active) return
    if (!this.key) return this.select(this.query, true)
    if (!this.paginated) { this.legacy = null; this.legacyIndex = null; return this.select(this.query, true) }
    const device = { ...this.device }, generation = this.generation
    try {
      if (!this.revisionFlight) this.revisionFlight = getLibraryRevision(device, this.controller.signal)
      const { revision, scanState } = await this.revisionFlight
      if (!await this.current(generation, device)) return
      if (revision === this.state.library.revision && !this.state.offline && !this.state.error) {
        this.publish({ library: { ...this.state.library, scanState, refreshing: scanState === 'refreshing' } })
        this.scheduleRefresh(); return
      }
      this.acceptRevision(revision)
      return this.select(this.query, true)
    } catch (error) { await this.failure(error, generation, device) }
    finally { if (this.valid(generation)) this.revisionFlight = null }
  }
  loadMore(): Promise<void> {
    if (this.disposed || !this.active) return Promise.resolve()
    if (this.pageFlight) return this.pageFlight
    if (!this.paginated || this.state.loading || !this.state.library.nextCursor) return Promise.resolve()
    const generation = this.generation, device = { ...this.device }, cursor = this.state.library.nextCursor, key = this.key
    const query = this.query, signal = this.controller.signal
    this.publish({ loadingMore: true, error: '' })
    const flight = (async () => {
      try {
        const page = await queryLibrary(device, { ...query, limit: LIBRARY_PAGE_SIZE, cursor }, signal)
        if (!await this.current(generation, device)) return
        if (page.revision !== this.state.library.revision) throw new ApiError('库已更新，请重新查询', 409, 'cursor_stale', false)
        const items = [...new Map([...this.state.library.items, ...page.items].map(item => [item.id, item])).values()]
        const response = { ...page, items, categoryGroups: this.state.library.categoryGroups,
          categoryPagination: this.state.library.categoryPagination,
          pagination: { offset: 0, limit: items.length, total: page.matchedCount ?? items.length, returned: items.length, hasMore: Boolean(page.nextCursor) } }
        this.cache(key, response); this.publish({ library: response, offline: false })
        await writeLibraryPageCache(device, key, response)
      } catch (error) {
        if (this.valid(generation) && error instanceof ApiError && error.code === 'cursor_stale') {
          await clearLibraryPageCache(device).catch(() => {})
          if (this.valid(generation)) await this.select(query, true)
        } else await this.failure(error, generation, device)
      } finally { if (this.valid(generation)) { this.publish({ loadingMore: false }); this.pageFlight = null } }
    })()
    this.pageFlight = flight
    return flight
  }
  loadCategories(type: 'custom' | 'system'): Promise<void> {
    if (this.disposed || !this.active) return Promise.resolve()
    if (this.categoryFlight) return this.categoryFlight
    const pagination = this.state.library.categoryPagination
    const cursor = type === 'custom' ? pagination?.customNextCursor : pagination?.systemNextCursor
    if (!this.paginated || !cursor) return Promise.resolve()
    const generation = this.generation, device = { ...this.device }, signal = this.controller.signal
    this.publish({ categoryLoading: type, error: '' })
    const flight = (async () => {
      try {
        const page = await getLibraryCategories(device, type, cursor, signal)
        if (!await this.current(generation, device)) return
        if (page.revision !== this.state.library.revision) throw new ApiError('分类已更新，请重新查询', 409, 'cursor_stale', false)
        const library = this.state.library
        const response = { ...library, categoryGroups: { custom: library.categoryGroups?.custom || [], system: library.categoryGroups?.system || [],
          [type]: [...new Map([...(library.categoryGroups?.[type] || []), ...page.items].map(item => [item.key, item])).values()] },
          categoryPagination: { ...pagination!, [type === 'custom' ? 'customNextCursor' : 'systemNextCursor']: page.nextCursor } }
        this.cache(this.key, response); this.publish({ library: response })
        await writeLibraryPageCache(device, this.key, response)
      } catch (error) {
        if (this.valid(generation) && error instanceof ApiError && error.code === 'cursor_stale') await this.select(this.query, true)
        else await this.failure(error, generation, device)
      } finally { if (this.valid(generation)) { this.publish({ categoryLoading: null }); this.categoryFlight = null } }
    })()
    this.categoryFlight = flight
    return flight
  }
  dispose() { this.disposed = true; this.cancel(); this.listeners.clear(); this.entries.clear(); this.bytes = 0 }
  diagnostics() { return { entries: this.entries.size, bytes: this.bytes, generation: this.generation } }
}
