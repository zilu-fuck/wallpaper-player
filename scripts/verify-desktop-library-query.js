const assert = require('assert')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
function verifyDesktopLibraryQuery() {
  const client = phone(), harness = createHookHarness(client)
  client.stubs.react.useDeferredValue = value => value
  const { useVideoFilter } = client.load('src/hooks/useVideoFilter.js')
  const videos = [
    { id: 'a', fullPath: 'E:/library/a.mp4', favoriteKey: 'a', name: 'Video 2', fileName: 'a', extension: '.mp4', size: 10, tags: [], systemTags: [] },
    { id: 'b', fullPath: 'E:/library/b.mp4', favoriteKey: 'b', name: 'Video 10', fileName: 'b', extension: '.mp4', size: 20, tags: ['TRAVEL'], systemTags: ['TRAVEL'] },
    { id: 'c', fullPath: 'E:/library/c.mp4', favoriteKey: 'c', name: 'Video 30', fileName: 'c', extension: '.mp4', size: 30, tags: ['Other'] }
  ]
  let props = { videos, customTags: { a: ['Travel', 'travel'], b: ['TRAVEL'] }, favoriteKeys: new Set(['a']), hiddenTags: [] }
  let result
  const render = () => { result = useVideoFilter(props); return result }
  harness.mount(render)
  assert.deepStrictEqual(Array.from(result.filteredVideos, video => video.id), ['a', 'b', 'c'])
  assert.strictEqual(result.categoryGroups.custom.length, 1)
  assert.strictEqual(result.categoryGroups.custom[0].count, 2, 'category counts must match normalized query semantics')
  result.setActiveCategory('custom:travel')
  return (async () => {
    await harness.settle()
    assert.deepStrictEqual(Array.from(result.filteredVideos, video => video.id), ['a', 'b'])
    result.setActiveCategory('system:travel'); await harness.settle()
    assert.deepStrictEqual(Array.from(result.filteredVideos, video => video.id), ['b'], 'typed include tags use an intersection')
    result.setActiveCategory('system:travel'); await harness.settle()
    assert.deepStrictEqual(Array.from(result.filteredVideos, video => video.id), ['a'], 'exclusion applies after inclusion')
    result.handleClearFilters(); result.setSearchQuery('VIDEO 2'); await harness.settle()
    assert.deepStrictEqual(Array.from(result.filteredVideos, video => video.id), ['a'])
    result.handleClearFilters(); await harness.settle()
    props = { ...props, hiddenTags: ['custom:TRAVEL'] }; harness.mount(render); await harness.settle()
    assert.deepStrictEqual(Array.from(result.filteredVideos, video => video.id), ['c'], 'old hidden keys follow canonical categories')
    harness.unmount()
    console.log('desktop library query passed: actual hook, shared predicates, natural order, typed intersections/exclusions, case-folded unique counts and legacy hidden keys')
  })()
}
module.exports = { verifyDesktopLibraryQuery }
