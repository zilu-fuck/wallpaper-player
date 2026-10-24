const { ipcMain: appIpcMain } = require('../security/ipc')
const { IPC } = require('../ipc-channels')
const { mediaWorkService } = require('../application/media-work-service')
const { mediaScheduler } = require('../application/resource-scheduler')
const {
  enrichNetworkResource,
  normalizeNetworkResourceInput,
  resolveKnownNetworkResourcePlayback
} = require('./network-resource-service')
const {
  loadSettings,
  saveSettingsAndFlush,
  sanitizeSettingsForRenderer
} = require('../settings')

function registerNetworkResourceIpc(ipcMain = appIpcMain) {
  const prepare = (event, input, operation) => mediaWorkService.run(event, input?.requestId, signal => mediaScheduler.enqueue({
    type: 'network-operation', resources: { prepare: 1 }, signal, priority: 80, timeoutMs: 45000 }, operation))
  ipcMain.handle(IPC.NETWORK_RESOURCE_ADD, async (event, input) => {
    try {
      return await prepare(event, input, async context => {
      const resource = await enrichNetworkResource(normalizeNetworkResourceInput(input), context)
      context.throwIfAborted()
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const exists = current.some(item => String(item.url).toLowerCase() === resource.url.toLowerCase())
      const next = exists
        ? current.map(item => String(item.url).toLowerCase() === resource.url.toLowerCase() ? { ...item, ...resource } : item)
        : [resource, ...current]
      const saved = await saveSettingsAndFlush({ networkResources: next })
      return { success: true, resource, settings: sanitizeSettingsForRenderer(saved) }
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.NETWORK_RESOURCE_UPDATE, async (event, input = {}) => {
    try {
      return await prepare(event, input, async context => {
      const id = String(input.id || '').trim()
      if (!id) {
        return { success: false, error: '未选择要修改的网络资源' }
      }
      const resource = await enrichNetworkResource(normalizeNetworkResourceInput(input), context)
      context.throwIfAborted()
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const index = current.findIndex(item => String(item.id || '') === id)
      if (index === -1) {
        return { success: false, error: '没有找到要修改的网络资源' }
      }
      const duplicate = current.some((item, itemIndex) => (
        itemIndex !== index &&
        String(item.url || '').trim().toLowerCase() === resource.url.toLowerCase()
      ))
      if (duplicate) {
        return { success: false, error: '已有相同地址的网络资源' }
      }
      const updated = {
        ...current[index],
        kind: resource.kind,
        title: resource.title,
        url: resource.url,
        playbackUrl: resource.playbackUrl,
        httpHeaders: resource.httpHeaders,
        parser: resource.parser,
        page: resource.page
      }
      const next = [...current]
      next[index] = updated
      const saved = await saveSettingsAndFlush({ networkResources: next })
      return { success: true, resource: updated, settings: sanitizeSettingsForRenderer(saved) }
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.NETWORK_RESOURCE_RESOLVE, async (event, input = {}) => {
    try {
      return await prepare(event, input, async context => {
        const resource = await resolveKnownNetworkResourcePlayback(input, context)
        context.throwIfAborted(); return { success: true, resource }
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.NETWORK_RESOURCE_REMOVE, async (_event, resourceId) => {
    try {
      const id = String(resourceId || '').trim()
      if (!id) {
        return { success: false, error: '未选择要移除的网络资源' }
      }
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const next = current.filter(item => String(item.id || '') !== id)
      if (next.length === current.length) {
        return { success: false, error: '没有找到要移除的网络资源' }
      }
      const saved = await saveSettingsAndFlush({ networkResources: next })
      return { success: true, removedCount: current.length - next.length, settings: sanitizeSettingsForRenderer(saved) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.NETWORK_RESOURCES_REMOVE, async (_event, resourceIds) => {
    try {
      const ids = new Set((Array.isArray(resourceIds) ? resourceIds : [])
        .map(item => String(item || '').trim())
        .filter(Boolean))
      if (ids.size === 0) {
        return { success: false, error: '未选择要移除的网络资源' }
      }
      const settings = loadSettings()
      const current = Array.isArray(settings.networkResources) ? settings.networkResources : []
      const next = current.filter(item => !ids.has(String(item.id || '')))
      if (next.length === current.length) {
        return { success: false, error: '没有找到要移除的网络资源' }
      }
      const saved = await saveSettingsAndFlush({ networkResources: next })
      return {
        success: true,
        removedCount: current.length - next.length,
        settings: sanitizeSettingsForRenderer(saved)
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerNetworkResourceIpc }
