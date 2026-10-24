const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const gate = require('./release-gate.cjs')

async function publishPreparedRelease({ tag, title, notes, files, manifestFile, adapter, verificationDirectory }) {
  const manifestDigest = (await gate.hashFile(manifestFile)).sha256
  const marker = '<!-- wallpaper-release-manifest:' + manifestDigest + ' -->'
  const existing = await adapter.view(tag)
  if (existing && !existing.body?.includes(marker)) throw Error('Release gate: existing public/unowned release cannot be replaced')
  const alreadyPublished = existing && !existing.isDraft
  if (!existing) await adapter.createDraft({ tag, title, body: notes + '\n\n' + marker })
  const assets = [...files, { path: manifestFile, name: 'release-manifest.json', ...await gate.hashFile(manifestFile) }]
  const current = await adapter.assets(tag)
  const expectedNames = new Set(assets.map(item => item.name))
  if (current.some(item => !expectedNames.has(item.name)) || new Set(current.map(item => item.name)).size !== current.length) throw Error('Release gate: unexpected assets in owned draft')
  for (const file of assets) {
    const prior = current.find(item => item.name === file.name)
    if (prior) {
      if (prior.size !== file.bytes) throw Error('Release gate: existing draft asset differs from this candidate')
    } else {
      if (alreadyPublished) throw Error('Release gate: published candidate has missing assets; no mutation attempted')
      await adapter.upload(tag, file)
    }
    const downloaded = path.join(verificationDirectory, gate.fileName(file.name))
    await adapter.download(tag, file.name, verificationDirectory)
    const digest = await gate.hashFile(downloaded)
    if (digest.sha256 !== file.sha256 || digest.bytes !== file.bytes) throw Error('Release gate: remote draft download differs from the prepared artifact')
  }
  const ready = await adapter.assets(tag)
  if (ready.length !== assets.length || new Set(ready.map(item => item.name)).size !== expectedNames.size || ready.some(item => !expectedNames.has(item.name) || item.size !== assets.find(file => file.name === item.name).bytes)) throw Error('Release gate: draft asset inventory changed before publication')
  if (alreadyPublished) return { published: true, alreadyPublished: true, assets: assets.length, manifestSha256: manifestDigest }
  await adapter.publish(tag)
  const published = await adapter.view(tag)
  if (!published || published.isDraft) throw Error('Release gate: publication state could not be confirmed')
  return { published: true, assets: assets.length, manifestSha256: manifestDigest }
}

function ghAdapter({ repository, temporaryDirectory, exec = execFileSync }) {
  const command = args => exec('gh', [...args, '--repo', repository], { encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 })
  return {
    async view(tag) {
      // An API/auth/network error must not be treated as permission to create a release.
      const releases = JSON.parse(command(['release', 'list', '--limit', '100', '--json', 'tagName,isDraft']))
      if (!releases.some(item => item.tagName === tag)) return null
      return JSON.parse(command(['release', 'view', tag, '--json', 'isDraft,body']))
    },
    async createDraft({ tag, title, body }) {
      const notesFile = path.join(temporaryDirectory, 'notes-' + crypto.randomUUID() + '.md')
      await fsp.writeFile(notesFile, body, { flag: 'wx' })
      command(['release', 'create', tag, '--verify-tag', '--draft', '--title', title, '--notes-file', notesFile])
    },
    async assets(tag) { return JSON.parse(command(['release', 'view', tag, '--json', 'assets'])).assets },
    async upload(tag, file) { command(['release', 'upload', tag, file.path]) },
    async download(tag, name, directory) { command(['release', 'download', tag, '--pattern', name, '--dir', directory]) },
    async publish(tag) { command(['release', 'edit', tag, '--draft=false', '--prerelease=false', '--latest']) }
  }
}

async function main() {
  const plan = gate.planFromEnvironment(process.env, { requireSigningSecrets: false }), output = path.resolve('.release/publish')
  await fsp.mkdir(output, { recursive: true })
  const prepared = await gate.assembleRelease({ plan, results: JSON.parse(process.env.RELEASE_JOB_RESULTS),
    directories: { windows: path.resolve('.release/windows'), android: path.resolve('.release/android') }, sourceCommit: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY })
  const manifestFile = path.join(output, 'release-manifest.json')
  await fsp.writeFile(manifestFile, JSON.stringify(prepared.manifest, null, 2) + '\n', { flag: 'wx' })
  const temporaryDirectory = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || output, 'wallpaper-release-'))
  const verificationDirectory = path.join(temporaryDirectory, 'verified'); await fsp.mkdir(verificationDirectory)
  const notesFile = path.resolve('release-notes', plan.tag + '.md')
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : 'Wallpaper Player ' + plan.desktopVersion
  const result = await publishPreparedRelease({ tag: plan.tag, title: 'Wallpaper Player ' + plan.desktopVersion, notes, files: prepared.files, manifestFile,
    adapter: ghAdapter({ repository: process.env.GITHUB_REPOSITORY, temporaryDirectory }), verificationDirectory })
  console.log(JSON.stringify(result))
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { publishPreparedRelease, ghAdapter }
