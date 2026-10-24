const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const asar = require('@electron/asar')
const io = require('./build-io.cjs')
const output = require('./build-output.cjs')
const plugins = require('./package-plugins.js')
const { packageWindows, validateWindowsOutput, resolveAsciiBuildRoot } = require('./package-win.js')
const root = path.resolve(__dirname, '..')
const results = []
let fixture, buildBase
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value) }
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')) }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }) }
async function check(name, action) { await action(); results.push(name) }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function main() {
  const parent = path.join(root, '.tmp/refactor-tests')
  await fs.mkdir(parent, { recursive: true })
  fixture = await fs.mkdtemp(path.join(parent, 'packaging-'))
  const project = path.join(fixture, "中文 项目' & $路径")
  await fs.mkdir(project)
  buildBase = path.join(resolveAsciiBuildRoot(), 'checks-' + crypto.randomUUID())
  await fs.mkdir(buildBase, { recursive: true })
  await write(path.join(buildBase, 'preexisting.txt'), 'leave previous diagnostic files alone')
  const source = path.join(project, 'copy-source')
  await write(path.join(source, "目录' & $空格", '.env.example'), '中文\n$literal & apostrophe\n')
  await write(path.join(source, 'binary.bin'), crypto.randomBytes(4096))
  await fs.mkdir(path.join(source, 'empty'))
  await write(path.join(source, '_downloads', 'ignore.bin'), 'excluded')
  await write(path.join(source, 'debug.PDB'), 'excluded')
  const external = path.join(fixture, 'external')
  await write(path.join(external, 'keep.txt'), 'outside source')
  await fs.symlink(external, path.join(source, 'wallpaper-player'), process.platform === 'win32' ? 'junction' : 'dir')
  const copied = path.join(buildBase, 'copy-destination')
  await check('real Unicode to ASCII copy; binary, dotfile, empty directory and excluded junction', async () => {
    const info = await io.copyItem(source, copied, { excludeNames: ['_downloads', 'wallpaper-player'], excludeFileExtensions: ['.pdb'] })
    assert.equal(info.files, 2)
    assert.equal(info.method, process.platform === 'win32' ? 'robocopy' : 'copyFile')
    for (const item of ['binary.bin', "目录' & $空格/.env.example"]) assert.deepEqual(await fs.readFile(path.join(source, item)), await fs.readFile(path.join(copied, item)))
    assert.ok((await fs.stat(path.join(copied, 'empty'))).isDirectory())
    for (const item of ['_downloads', 'debug.PDB', 'wallpaper-player']) await absent(path.join(copied, item))
  })
  await check('unexpected links, destination aliases and overlapping paths fail before copying', async () => {
    await assert.rejects(io.copyItem(source, path.join(buildBase, 'unfiltered')), /unexpected source link/)
    await fs.symlink(external, path.join(buildBase, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(io.copyItem(source, path.join(buildBase, 'alias', 'child')), /linked path/)
    await assert.rejects(io.copyItem(source, path.join(source, 'child')), /overlap/)
    assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'outside source')
  })
  await check('copy inventory rejects a command that silently copies nothing', async () => {
    await assert.rejects(io.copyItem(source, path.join(buildBase, 'empty-copy'), { excludeNames: ['_downloads', 'wallpaper-player'], excludeFileExtensions: ['.pdb'], run: async () => ({ code: 0 }) }), /inventory differs/)
  })
  await check('cleanup requires exact own stage, rejects portable Data and descendant links', async () => {
    await assert.rejects(io.createStage(path.join(project, 'nested-stage'), project), /outside the project|ASCII/)
    const changed = await io.createStage(buildBase, project)
    await io.atomicJson(path.join(changed.stage, '.wallpaper-build-stage.json'), { ...changed.owner, id: crypto.randomUUID() })
    await assert.rejects(io.removeStage(changed.stage, changed.owner), /owner marker/)
    const data = await io.createStage(buildBase, project)
    await write(path.join(data.stage, 'release/win-unpacked/Data/settings.json'), 'retained portable data')
    await assert.rejects(io.removeStage(data.stage, data.owner), /portable data/)
    const linked = await io.createStage(buildBase, project)
    await fs.symlink(external, path.join(linked.stage, 'unexpected'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(io.removeStage(linked.stage, linked.owner), /unexpected source link/)
    const clean = await io.createStage(buildBase, project)
    await write(path.join(clean.stage, 'own.txt'), 'own')
    await io.removeStage(clean.stage, clean.owner)
    await absent(clean.stage)
    assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'outside source')
  })

  const manifest = { name: 'wallpaper-packaging-fixture', version: '9.9.0', main: 'main.js', build: { directories: { output: 'release' } } }
  await write(path.join(project, 'package.json'), JSON.stringify(manifest))
  await write(path.join(project, 'main.js'), '// fixture main')
  await write(path.join(project, 'main/plugins/official-package-integrity.json'), '{"source":"unchanged"}\n')
  const sourceIntegrity = await fs.readFile(path.join(project, 'main/plugins/official-package-integrity.json'))
  for (const id of ['video-analysis', 'ai-search', 'agent-bridge']) {
    await write(path.join(project, 'main/plugins', id, 'plugin.json'), JSON.stringify({ id, version: '1.0.0' }))
    await write(path.join(project, 'main/plugins', id, "中文' & $readme.txt"), 'fixture payload')
    await write(path.join(project, 'main/plugins', id, 'resources', 'must-not-copy.txt'), 'stale resource')
  }
  await write(path.join(project, 'node_modules/playwright-core/package.json'), '{"name":"playwright-core","version":"1.0.0"}')
  await write(path.join(project, 'node_modules/playwright-core/index.js'), '// dependency fixture')
  const runtime = path.join(project, 'main/video-comprehension-runtime')
  for (const item of ['pyproject.toml', '.env.example', 'README.md', 'uv.lock', 'docs/中文.md', 'video_comprehension/pipeline.py']) await write(path.join(runtime, item), 'fixture\n')
  await write(path.join(runtime, 'video_comprehension/cli.py'), 'import argparse\nfrom pathlib import Path\n    result = run_pipeline(load_request_from_env(Path(args.video_path)))\n')
  await write(path.join(runtime, 'video_comprehension/config.py'), 'from __future__ import annotations\n\nfrom dataclasses\n    yolo_model = resolve_model_path(model_storage_dir, DEFAULT_YOLO_MODEL)\n        output_dir=DEFAULT_OUTPUT_DIR,\n')
  for (const name of ['llama.cpp', 'llama.cpp-cuda']) {
    await write(path.join(project, 'vendor', name, 'runtime.dll'), 'bounded vendor fixture')
    await write(path.join(project, 'vendor', name, 'debug.pdb'), 'excluded debug file')
  }
  await write(path.join(project, 'vendor/_downloads/cache.bin'), 'excluded cache')
  await write(path.join(project, 'vendor/ffmpeg/runtime.dll'), 'core vendor fixture')
  await fs.symlink(project, path.join(project, 'node_modules/wallpaper-player'), process.platform === 'win32' ? 'junction' : 'dir')
  await write(path.join(project, 'release/legacy.exe'), 'previous release')
  await write(path.join(project, 'release/win-unpacked/Data/settings.json'), 'previous portable profile')
  const payloadStage = path.join(buildBase, 'payload-stage'), zipDir = path.join(buildBase, 'zip-output'), integrityPath = path.join(buildBase, 'plugin-integrity.json')
  let built
  await check('real plugin ZIPs include hidden runtime files, patched Python and selected dependencies', async () => {
    built = await plugins.buildPluginSet({ rootDir: project, stageRoot: payloadStage, outputDir: zipDir, integrityPath })
    assert.equal(built.outputs.length, 3)
    const extract = path.join(fixture, "解压' & $目录")
    await io.run('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:WP_ZIP_INPUT,$env:WP_ZIP_EXTRACT)"], { env: { ...process.env, WP_ZIP_INPUT: built.outputs[0].outputZip, WP_ZIP_EXTRACT: extract } })
    const unpacked = path.join(extract, 'video-analysis')
    assert.equal(await plugins.hashDirectorySha256(unpacked), built.outputs[0].payloadSha256)
    for (const relative of ['resources/video-comprehension-runtime/.env.example', 'resources/video comprehension/video comprehension/.env.example']) assert.equal(await fs.readFile(path.join(unpacked, relative), 'utf8'), 'fixture\n')
    assert.match(await fs.readFile(path.join(unpacked, 'resources/video-comprehension-runtime/video_comprehension/cli.py'), 'utf8'), /VIDEO_COMPREHENSION_ENV/)
    await absent(path.join(unpacked, 'resources/vendor/llama.cpp/debug.pdb'))
    await absent(path.join(unpacked, 'resources/must-not-copy.txt'))
  })
  await check('standalone plugin build publishes its own pointer without rewriting development integrity', async () => {
    const result = await plugins.packagePlugins({ rootDir: project, buildBase })
    assert.equal((await output.resolveOutput(project, 'plugins', { mode: 'plugins', version: '9.9.0' })).directory, result.directory)
    await plugins.validatePluginOutput(result.directory)
    await assert.rejects(plugins.buildPluginSet({ rootDir: project, stageRoot: path.join(buildBase, 'forbidden-source-stage'), outputDir: path.join(buildBase, 'forbidden-source-output'), integrityPath: path.join(project, 'main/plugins/official-package-integrity.json') }), /cannot rewrite source integrity/)
    assert.deepEqual(await fs.readFile(path.join(project, 'main/plugins/official-package-integrity.json')), sourceIntegrity)
  })
  async function preparedPlugins(options) {
    await io.copyItem(zipDir, options.outputDir)
    await io.atomicJson(options.integrityPath, built.integrity)
  }
  const stages = []
  async function fakeBuilder(_command, args, { cwd }) {
    stages.push(cwd)
    assert.ok(args.includes('--x64'))
    assert.deepEqual(args.slice(-2), ['--publish', 'never'])
    assert.equal(await fs.readFile(path.join(project, 'release/legacy.exe'), 'utf8'), 'previous release')
    for (const relative of ['main/plugins/video-analysis', 'main/plugins/ai-search', 'main/plugins/agent-bridge', 'main/video-comprehension-runtime', 'vendor/_downloads', 'vendor/llama.cpp', 'vendor/llama.cpp-cuda', 'node_modules/wallpaper-player']) await absent(path.join(cwd, relative))
    assert.deepEqual(await json(path.join(cwd, 'main/plugins/official-package-integrity.json')), built.integrity)
    const content = path.join(cwd, 'fixture-asar')
    await write(path.join(content, 'package.json'), JSON.stringify(manifest))
    await write(path.join(content, 'main/plugins/official-package-integrity.json'), JSON.stringify(built.integrity))
    const archive = path.join(cwd, 'release/win-unpacked/resources/app.asar')
    await fs.mkdir(path.dirname(archive), { recursive: true })
    await asar.createPackage(content, archive)
  }
  const options = { rootDir: project, buildBase, mode: 'directory', buildPlugins: preparedPlugins, runCommand: fakeBuilder }
  let success
  await check('Windows pipeline embeds matching integrity, publishes owned output and cleans only its stage', async () => {
    success = await packageWindows(options)
    assert.equal((await output.resolveOutput(project, 'windows', { mode: 'directory', version: '9.9.0' })).directory, success.directory)
    await absent(stages.at(-1))
    assert.deepEqual(await fs.readFile(path.join(project, 'main/plugins/official-package-integrity.json')), sourceIntegrity)
    assert.equal(await fs.readFile(path.join(project, 'release/win-unpacked/Data/settings.json'), 'utf8'), 'previous portable profile')
    assert.equal(await fs.readFile(path.join(buildBase, 'preexisting.txt'), 'utf8'), 'leave previous diagnostic files alone')
  })
  const pointer = await fs.readFile(output.pointerPath(project, 'windows'))
  await check('plugin assembly failure retains previous pointer and source integrity', async () => {
    await assert.rejects(packageWindows({ ...options, buildPlugins: async () => { throw new Error('injected plugin failure') } }), /injected plugin failure/)
    assert.deepEqual(await fs.readFile(output.pointerPath(project, 'windows')), pointer)
  })
  await check('builder failure retains its own stage and all previous releases', async () => {
    let failedStage
    await assert.rejects(packageWindows({ ...options, runCommand: async (_exe, _args, { cwd }) => { failedStage = cwd; throw new Error('injected builder failure') } }), /injected builder failure/)
    assert.ok((await fs.stat(failedStage)).isDirectory())
    assert.deepEqual(await fs.readFile(output.pointerPath(project, 'windows')), pointer)
    assert.ok((await fs.stat(success.directory)).isDirectory())
  })
  await check('ASAR mismatch, ZIP corruption and missing distribution files are rejected', async () => {
    await assert.rejects(validateWindowsOutput(success.directory, { version: '9.9.1', mode: 'directory' }), /version differs/)
    await assert.rejects(validateWindowsOutput(success.directory, { version: '9.9.0', mode: 'distribution' }), /ENOENT/)
    await assert.rejects(packageWindows({ ...options, buildPlugins: async args => { await preparedPlugins(args); await fs.appendFile(path.join(args.outputDir, path.basename(built.outputs[0].outputZip)), 'corrupted transport') } }), /archive differs/)
    const mismatched = path.join(fixture, 'mismatched-output')
    await io.copyItem(success.directory, mismatched)
    const wrongAsar = path.join(fixture, 'wrong-asar')
    await write(path.join(wrongAsar, 'package.json'), JSON.stringify(manifest))
    await write(path.join(wrongAsar, 'main/plugins/official-package-integrity.json'), '{}')
    await asar.createPackage(wrongAsar, path.join(mismatched, 'win-unpacked/resources/app.asar'))
    asar.uncache(path.join(mismatched, 'win-unpacked/resources/app.asar'))
    await assert.rejects(validateWindowsOutput(mismatched, { version: '9.9.0', mode: 'directory' }), /app integrity differs/)
    assert.deepEqual(await fs.readFile(output.pointerPath(project, 'windows')), pointer)
  })
  await check('interruption before pointer leaves complete orphan output and previous selection', async () => {
    let orphan
    await assert.rejects(packageWindows({ ...options, beforePointer: async info => { orphan = info.directory; throw new Error('injected pointer interruption') } }), /pointer interruption/)
    await validateWindowsOutput(orphan, { version: '9.9.0', mode: 'directory' })
    assert.deepEqual(await fs.readFile(output.pointerPath(project, 'windows')), pointer)
  })
  await check('two concurrent builds keep distinct outputs; pointer selects last completed writer', async () => {
    const readyA = deferred(), readyB = deferred(), resumeA = deferred(), resumeB = deferred()
    const first = packageWindows({ ...options, beforePointer: async () => { readyA.resolve(); await resumeA.promise } })
    const second = packageWindows({ ...options, beforePointer: async () => { readyB.resolve(); await resumeB.promise } })
    await Promise.all([readyA.promise, readyB.promise])
    resumeB.resolve(); const b = await second
    assert.equal((await output.resolveOutput(project, 'windows')).directory, b.directory)
    resumeA.resolve(); const a = await first
    assert.notEqual(a.directory, b.directory)
    assert.equal((await output.resolveOutput(project, 'windows')).directory, a.directory)
    await validateWindowsOutput(b.directory, { version: '9.9.0', mode: 'directory' })
    await assert.rejects(output.resolveOutput(project, 'windows', { mode: 'distribution' }), /mode differs/)
    await assert.rejects(output.resolveOutput(project, 'windows', { sourceCommit: 'a'.repeat(40) }), /sourceCommit differs/)
  })
  await check('distribution output selects only its matching ASAR, ZIPs and update assets', async () => {
    const releaseGate = require('./release-gate.cjs')
    const distribution = await packageWindows({ ...options, mode: 'distribution',
      runCommand: async (exe, args, opts) => {
        assert.ok(args.includes('--win')); await fakeBuilder(exe, args, opts)
        const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x14c, 68)
        for (const name of ['Wallpaper-Player-Setup-9.9.0.exe', 'Wallpaper-Player-9.9.0.exe']) await write(path.join(opts.cwd, 'release', name), pe)
        await write(path.join(opts.cwd, 'release/Wallpaper-Player-Setup-9.9.0.exe.blockmap'), 'bounded blockmap fixture')
        const digest = await releaseGate.hashFile(path.join(opts.cwd, 'release/Wallpaper-Player-Setup-9.9.0.exe'))
        await write(path.join(opts.cwd, 'release/latest.yml'), `version: 9.9.0\nfiles:\n  - url: Wallpaper-Player-Setup-9.9.0.exe\n    sha512: ${digest.sha512}\n    size: ${digest.bytes}\npath: Wallpaper-Player-Setup-9.9.0.exe\nsha512: ${digest.sha512}\n`)
      }, validate: (dir, opts) => validateWindowsOutput(dir, { ...opts, inspectVersion: () => ({ productVersion: '9.9.0', signatureStatus: 'NotSigned' }) }) })
    assert.equal((await output.resolveOutput(project, 'windows', { mode: 'distribution', version: '9.9.0' })).directory, distribution.directory)
    const transfer = path.join(fixture, 'staged-distribution')
    const part = await releaseGate.collectWindows({ directory: distribution.directory, version: '9.9.0', sourceCommit: 'a'.repeat(40), integrity: built.integrity,
      inspectVersion: () => ({ productVersion: '9.9.0', signatureStatus: 'NotSigned' }) })
    await releaseGate.stagePart(part, distribution.directory, transfer)
    assert.equal((await json(path.join(transfer, 'part.json'))).assets.length, 7)
  })
  await check('unknown pointer owner, changed marker and linked output cannot be selected', async () => {
    const file = output.pointerPath(project, 'windows'), valid = await json(file)
    await io.atomicJson(file, { ...valid, output: '../elsewhere' })
    await assert.rejects(packageWindows(options), /invalid output location/)
    await io.atomicJson(file, valid)
    const selected = await output.resolveOutput(project, 'windows')
    await io.atomicJson(path.join(selected.directory, output.markerName), { ...valid, id: crypto.randomUUID() })
    await assert.rejects(output.resolveOutput(project, 'windows'), /marker differs/)
    await io.atomicJson(path.join(selected.directory, output.markerName), valid)
    await fs.symlink(external, path.join(selected.directory, 'injected-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(output.resolveOutput(project, 'windows'), /unexpected source link/)
  })
  await check('final legacy artifacts, portable profile, source integrity and external target remain byte-identical', async () => {
    assert.equal(await fs.readFile(path.join(project, 'release/legacy.exe'), 'utf8'), 'previous release')
    assert.equal(await fs.readFile(path.join(project, 'release/win-unpacked/Data/settings.json'), 'utf8'), 'previous portable profile')
    assert.deepEqual(await fs.readFile(path.join(project, 'main/plugins/official-package-integrity.json')), sourceIntegrity)
    assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'outside source')
  })
  const workflow = require('js-yaml').load(await fs.readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'))
  assert.ok(workflow.jobs['verify-core'].steps.some(item => item.run === 'npm run verify:packaging'))
  assert.ok(workflow.jobs['verify-core'].steps.some(item => item.run === 'npm run verify:plugin-external'))
  const report = { passed: true, cases: results, fixture, buildBase, retainedBecause: 'Intentional junction and failure-recovery fixtures; no recursive cleanup', platform: process.platform }
  await io.atomicJson(path.join(fixture, 'result.json'), report)
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); console.error('Retained packaging fixtures:', fixture, buildBase); process.exitCode = 1 })
