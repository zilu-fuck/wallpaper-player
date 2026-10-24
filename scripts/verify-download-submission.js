const assert = require('assert'), crypto = require('crypto')
const { phone } = require('./mobile-module-harness')
const { createHookHarness } = require('./verify-mobile-player-behavior')
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
async function main() {
  const client = phone(), calls = [], cancelled = []
  client.control.globals = { crypto }
  const { DownloadSubmission } = client.load('src/services/download-submission.js')
  const api = { downloadAddUrl: payload => new Promise((resolve, reject) => calls.push({ payload, resolve, reject })), cancelMediaWork: async id => cancelled.push(id) }
  const submission = new DownloadSubmission(api), payload = { url: 'https://source.invalid/video.mp4', dir: 'E:/fixture' }
  const a = submission.submit('downloadAddUrl', payload).catch(error => error), b = submission.submit('downloadAddUrl', payload).catch(error => error)
  assert.strictEqual(calls.length, 1); calls[0].reject(new Error('lost IPC ACK'))
  assert.match((await a).message, /未确认/); await b
  const retry = submission.submit('downloadAddUrl', payload)
  assert.strictEqual(calls[1].payload.operationId, calls[0].payload.operationId)
  calls[1].resolve({ success: true, gid: 'same-task' }); await retry
  submission.newIntent(); const explicit = submission.submit('downloadAddUrl', payload)
  assert.notStrictEqual(calls[2].payload.operationId, calls[0].payload.operationId)
  submission.newIntent(); calls[2].resolve({ success: true }); await assert.rejects(explicit, error => error.code === 'download_submission_retired')
  assert.ok(cancelled.includes(calls[2].payload.operationId))
  const final = submission.submit('downloadAddUrl', payload); submission.dispose(); calls[3].resolve({ success: true })
  await assert.rejects(final, error => error.code === 'download_submission_retired')
  assert.ok(cancelled.includes(calls[3].payload.operationId))

  const ui = phone(), harness = createHookHarness(ui), selections = [], submissions = []
  const metadataGid = 'aaaaaaaaaaaaaaaa', otherGid = 'bbbbbbbbbbbbbbbb', ownGid = 'dddddddddddddddd'
  const other = { gid: otherGid, rootGid: 'cccccccccccccccc', status: 'paused', name: 'Same Movie', dir: 'E:/library', bittorrent: {}, files: [{ index: 1, path: 'E:/library/Movie.mp4' }] }
  let state = { engine: {}, tasks: [] }, renders = 0
  ui.override('src/hooks/useDownloadStateObserver.js', { useDownloadStateObserver: () => ({ state, setState: value => { state = value }, refreshState: async () => {} }) })
  ui.stubs['react-dom'] = { createPortal: tree => tree }
  ui.control.globals = { ...ui.control.globals, crypto, window: { addEventListener() {}, removeEventListener() {}, electronAPI: {
    downloadSelectDirectory: async () => ({ success: true, path: 'E:/library', libraryDirectory: true }),
    downloadAddMagnet: async payload => { submissions.push(payload); return { success: true, gid: metadataGid, state: { engine: {}, tasks: [
      { gid: metadataGid, name: '[METADATA] Same Movie', status: 'complete', followedBy: [], files: [] }, other
    ] } } },
    downloadSelectFiles: async (gid, indexes, options) => { selections.push({ gid, indexes, options }); return { success: true, ...state } },
    cancelMediaWork: async () => ({ success: true })
  } }, document: { querySelector: () => null, body: { classList: { add() {}, remove() {} } } } }
  const Center = ui.load('src/components/DownloadCenter.jsx').default
  const props = { libraryDirectories: ['E:/library'], pendingRequest: { type: 'magnet', magnet: 'magnet:?xt=urn:btih:' + '1'.repeat(40) + '&dn=Same%20Movie' } }
  const render = () => { renders++; return Center(props) }
  harness.mount(render); await harness.settle()
  const form = nodes(harness.tree(), node => node.type === 'form' && node.props.className === 'download-dialog')[0]
  assert.ok(form); await form.props.onSubmit({ preventDefault() {} }); await harness.settle()
  assert.strictEqual(submissions.length, 1); assert.match(submissions[0].operationId, /^add-/)
  assert.strictEqual(nodes(harness.tree(), node => node.type === 'form' && node.props.className.includes('download-file-dialog')).length, 0,
    'same name and directory never associate another task with this magnet')
  state = { engine: {}, tasks: [state.tasks[0], other, { ...other, gid: ownGid, rootGid: metadataGid, following: metadataGid, taskGeneration: 'own-generation' }] }
  harness.mount(render); await harness.settle()
  const files = nodes(harness.tree(), node => node.type === 'form' && node.props.className.includes('download-file-dialog'))[0]
  assert.ok(files); const before = renders; await harness.settle(); assert.strictEqual(renders, before, 'associated metadata settles without a render loop')
  files.props.onSubmit({ preventDefault() {} }); await harness.until(() => selections.length === 1)
  assert.strictEqual(selections[0].gid, ownGid); assert.deepStrictEqual(selections[0].indexes, [1])
  assert.strictEqual(selections[0].options.expectedGeneration, 'own-generation')
  harness.unmount()
  console.log('download submission passed: production submission and complete center, same operation after lost ACK, explicit new intent, retired/unmounted isolation, cancel-before-admission identifiers and exact metadata association without name/directory guessing')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
