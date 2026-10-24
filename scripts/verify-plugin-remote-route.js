const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { requestJson } = require('./verify-helpers')

const projectRoot = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-player-plugin-route-'))

process.chdir(tempRoot)

const { pluginRegistry } = require(path.join(projectRoot, 'main', 'plugins'))
const { loadIdentity, flushIdentityWrites } = require(path.join(projectRoot, 'main', 'remote', 'identity'))
const { saveSettingsAndFlush } = require(path.join(projectRoot, 'main', 'settings'))
const { createRemoteServer } = require(path.join(projectRoot, 'main', 'remote', 'server'))

async function main() {
  await pluginRegistry.register({
    id: 'verify-plugin-route',
    name: 'Verify Plugin Route',
    enabled: true,
    setup(ctx) {
      ctx.remote.route('GET', '/v1/plugin-route/:value', async (_req, res, routeContext) => {
        assert.strictEqual(routeContext.authorizeMedia(_req, res), true, 'installed plugins retain a synchronous boolean')
        assert.strictEqual(await routeContext.authorizeMediaAsync(_req, res), true)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        })
        res.end(JSON.stringify({
          value: routeContext.params.value,
          hasResolver: typeof routeContext.resolveVideoPath === 'function'
        }))
      })
    }
  })

  await saveSettingsAndFlush({ remoteAccess: { enabled: true, port: 38127, keepRunningInTray: true, allowLegacyToken: true } })
  const token = loadIdentity().accessToken
  const server = createRemoteServer({ port: 0 })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`
    const unauthorized = await requestJson(`${baseUrl}/v1/plugin-route/test`)
    assert.strictEqual(unauthorized.status, 401)

    const routed = await requestJson(`${baseUrl}/v1/plugin-route/foo%20bar`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.strictEqual(routed.status, 200)
    assert.deepStrictEqual(routed.data, {
      value: 'foo bar',
      hasResolver: true
    })

    console.log('plugin remote route verification passed')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await pluginRegistry.dispose()
    await flushIdentityWrites()
  }
}

main()
  .finally(() => {
    process.chdir(projectRoot)
    assert.strictEqual(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(tempRoot).startsWith('wallpaper-player-plugin-route-'))
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
