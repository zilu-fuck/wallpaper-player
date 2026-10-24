const assert = require('assert')
const { phone } = require('./mobile-module-harness')

async function verifyMobileLibraryPages({ endpoint, token, mutate, video }) {
  const client = phone()
  const devices = client.load('mobile/src/persistence/devices.ts')
  const device = await devices.saveDevice({ id: 'paging-phone', name: 'Paging desktop', endpoint, token,
    capabilities: { libraryQuery: true, libraryRevision: true, cursorPagination: true } })
  const { LibraryRepository } = client.load('mobile/src/services/library-repository.ts')
  let pageCalls = 0, revisionCalls = 0, fullCalls = 0
  client.control.hold = async url => {
    if (String(url).endsWith('/v1/library/query')) pageCalls++
    if (String(url).endsWith('/v1/library/revision')) revisionCalls++
    if (String(url).endsWith('/v1/library')) fullCalls++
  }
  const repo = new LibraryRepository(device)
  await repo.select({})
  assert.strictEqual(repo.state.library.items.length, 200)
  assert.strictEqual(repo.state.library.count, 245)
  assert.strictEqual(repo.state.library.matchedCount, 245)
  assert.strictEqual(fullCalls, 0, 'modern phone must not fetch the legacy full library')
  assert.strictEqual(repo.state.library.categoryGroups.custom.length, 100)
  await repo.loadCategories('custom')
  assert.ok(repo.state.library.categoryGroups.custom.length > 100)
  assert.strictEqual(repo.state.library.categoryGroups.custom.find(item => item.name === 'Include').count, 2)
  const next = repo.loadMore()
  assert.strictEqual(repo.loadMore(), next, 'end reached is single flight')
  await next
  assert.strictEqual(repo.state.library.items.length, 245)
  assert.strictEqual(repo.state.library.pagination.returned, 245)
  assert.strictEqual(new Set(repo.state.library.items.map(item => item.id)).size, 245)
  const oldPages = pageCalls, oldRevisions = revisionCalls
  await Promise.all([repo.refresh(), repo.refresh(), repo.refresh()])
  assert.strictEqual(revisionCalls - oldRevisions, 1)
  assert.strictEqual(pageCalls, oldPages, 'unchanged revision must preserve loaded pages')
  await mutate(video, ['refresh-mutated'])
  const beforeChangedRefresh = pageCalls
  await Promise.all([repo.refresh(), repo.refresh(), repo.refresh()])
  assert.strictEqual(pageCalls - beforeChangedRefresh, 1, 'changed revisions must also share one reload')
  assert.strictEqual(repo.state.library.items.length, 200)
  await repo.loadMore()
  await repo.select({ query: 'Unique-240' })
  assert.strictEqual(repo.state.library.items.length, 1)
  assert.strictEqual(repo.state.library.items[0].name, 'Clip-240', 'search queries the entire desktop index')
  client.control.online = false
  const offline = new LibraryRepository(device)
  await offline.select({ query: 'Unique-240' })
  assert.strictEqual(offline.state.library.items.length, 1)
  assert.ok(offline.state.offline)
  await offline.select({ query: 'never-cached-query' })
  assert.strictEqual(offline.state.library.items.length, 0)
  assert.ok(offline.state.error, 'uncached offline queries must report unavailability')
  client.control.online = true

  let release, started
  const blocked = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  let heldSignal
  client.control.hold = async (url, options) => {
    if (String(url).endsWith('/v1/library/query') && JSON.parse(options.body).query === 'slow-old') {
      heldSignal = options.signal; started(); await blocked
    }
  }
  const slow = repo.select({ query: 'slow-old' })
  await entered
  await repo.select({ query: 'Clip-239' })
  release(); await slow
  assert.ok(heldSignal.aborted)
  assert.strictEqual(repo.state.library.items[0].name, 'Clip-239', 'late responses must not publish into the new query')
  client.control.hold = null
  await repo.select({ sort: 'date' })
  await mutate(video, ['cursor-mutated'])
  await repo.loadMore()
  assert.strictEqual(repo.state.library.items.length, 200, 'stale cursors restart rather than concatenate revisions')
  assert.strictEqual(repo.state.error, '')
  await repo.loadMore()
  assert.strictEqual(repo.state.library.items.length, 245)

  const persistence = client.load('mobile/src/persistence/library-pages.ts')
  for (let index = 0; index < 15; index++) {
    await persistence.writeLibraryPageCache(device, 'query-' + index, repo.state.library)
  }
  const book = client.async.values.get('wallpaper-player.library-pages.' + device.id)
  assert.ok(book.length * 2 <= persistence.LIBRARY_CACHE_BYTES)
  assert.ok(JSON.parse(book).entries.length <= persistence.LIBRARY_CACHE_ENTRIES)
  assert.ok(!book.includes(token), 'cache must not persist the bearer credential')
  for (let index = 0; index < 10; index++) await repo.select({ query: 'Clip-' + index })
  assert.ok(repo.diagnostics().entries <= 8)
  assert.ok(repo.diagnostics().bytes <= 8 * 1024 * 1024)

  client.control.hold = async (url, options) => {
    if (String(url).endsWith('/v1/library/query') && JSON.parse(options.body).query === 'removed-device') {
      started(); await blockedRemoval
    }
  }
  let unblockRemoval
  const blockedRemoval = new Promise(resolve => { unblockRemoval = resolve })
  const removing = repo.select({ query: 'removed-device' })
  await new Promise(resolve => setTimeout(resolve, 10))
  await devices.removeDevice(device.id, device.bindingId)
  unblockRemoval(); await removing
  assert.strictEqual(repo.state.library.items.length, 0)
  assert.strictEqual(client.async.values.has('wallpaper-player.library-pages.' + device.id), false)
  const rebound = await devices.saveDevice({ ...device, token })
  assert.notStrictEqual(rebound.bindingId, device.bindingId)
  assert.strictEqual(await persistence.readLibraryPageCache(device, 'query-14'), null)

  const old = new LibraryRepository({ ...rebound, capabilities: {} })
  client.control.hold = async url => { if (String(url).endsWith('/v1/library')) fullCalls++ }
  await old.select({ query: 'Unique-240' })
  assert.strictEqual(old.state.library.items.length, 1)
  await old.select({ query: 'Clip-239' })
  assert.strictEqual(fullCalls, 1, 'legacy desktop full snapshot is reused across local queries')
  const rootDirectory = old.state.library.directories.find(directory => directory.name === 'library')
  await old.select({ directoryId: rootDirectory.id, query: 'library' })
  assert.strictEqual(old.state.library.items.length, 245, 'legacy overlapping roots retain membership and searchable directory names')
  await old.select({ query: 'x'.repeat(1001) })
  assert.ok(old.state.error && !old.state.retryable, 'invalid input must report an error without crashing the screen')
  repo.dispose(); offline.dispose(); old.dispose()
  console.log('mobile library pages passed: actual API/repository, 200-item pages, full-index search, deduplication, single flight, revision reuse/restart, cancellation, offline query cache, bounded persistence, removal/rebinding and legacy compatibility')
}
module.exports = { verifyMobileLibraryPages }
