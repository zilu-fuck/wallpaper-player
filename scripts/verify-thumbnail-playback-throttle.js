const assert = require('assert')
const path = require('path')

const projectRoot = path.resolve(__dirname, '..')
const {
  enqueueThumbnailJob,
  setMediaPlaybackActive
} = require(path.join(projectRoot, 'main', 'thumbnail'))

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  const events = []

  setMediaPlaybackActive(true)
  const thumbnailPromise = enqueueThumbnailJob(async () => {
    events.push('thumbnail')
    return 'thumbnail'
  })
  const previewPromise = enqueueThumbnailJob(async () => {
    events.push('preview')
    return 'preview'
  }, { priority: 'preview' })

  await delay(20)
  assert.deepStrictEqual(events, ['preview'])
  assert.strictEqual(await previewPromise, 'preview')

  setMediaPlaybackActive(false)
  assert.strictEqual(await thumbnailPromise, 'thumbnail')
  assert.deepStrictEqual(events, ['preview', 'thumbnail'])

  setMediaPlaybackActive(true)
  const pruned = []
  const queuedThumbnails = Array.from({ length: 140 }, (_, index) => (
    enqueueThumbnailJob(async () => {
      pruned.push(index)
      return index
    })
  ))
  const settledWhilePlaying = []
  queuedThumbnails.forEach(promise => {
    promise.then(value => settledWhilePlaying.push(value))
  })
  const queuedPreview = enqueueThumbnailJob(async () => 'kept-preview', { priority: 'preview' })

  await delay(20)
  assert.strictEqual(await queuedPreview, 'kept-preview')
  assert.ok(settledWhilePlaying.filter(value => value === null).length >= 20)
  assert.strictEqual(pruned.length, 0)

  setMediaPlaybackActive(false)
  const settledAfterPlayback = await Promise.all(queuedThumbnails)
  assert.ok(settledAfterPlayback.some(value => Number.isInteger(value)))

  console.log('thumbnail playback throttle verification passed')
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    setMediaPlaybackActive(false)
  })
