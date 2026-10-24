import type { StoredDevice } from '../types'
import { loadDevice, runWithCurrentDevice, subscribeDeviceChanges } from '../persistence/devices'
import { confirmUpdateServerProtocol } from './connection-manager'
import { getActiveDeviceContext, subscribeActiveDeviceContext } from './active-device-context'

type ServerContext = { serverProtocol: number, minClientProtocol: number, source: 'global' | 'device', deviceId?: string }
export type UpdateServerLease = { resolve(): Promise<ServerContext>, validate(): Promise<void>, dispose(): void }
const cancelled = () => Object.assign(new Error('检查更新已取消'), { name: 'AbortError' })
const LEGACY_PROTOCOL = 1

export function acquireUpdateServerContext(signal: AbortSignal, invalidated: () => void): UpdateServerLease {
  const focus = getActiveDeviceContext()
  if (focus.kind === 'ambiguous') throw new Error('无法确定当前电脑，请关闭其他导航上下文后重新检查')
  if (signal.aborted) throw cancelled()
  let disposed = false, expected: StoredDevice | null = null
  const assertCurrent = () => {
    if (disposed || signal.aborted) throw cancelled()
    if (getActiveDeviceContext() !== focus) throw new Error('当前电脑已切换，请重新检查更新')
  }
  const navigationChanged = () => { if (getActiveDeviceContext() !== focus) invalidated() }
  const unsubscribeNavigation = subscribeActiveDeviceContext(navigationChanged)
  const unsubscribeBinding = subscribeDeviceChanges(change => {
    if (focus.kind === 'device' && change.deviceId === focus.deviceId && change.previousBindingId === focus.bindingId) invalidated()
  })
  function dispose() {
    if (disposed) return
    disposed = true; expected = null
    unsubscribeNavigation(); unsubscribeBinding(); signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  return {
    async resolve() {
      assertCurrent()
      if (focus.kind !== 'device') return { serverProtocol: LEGACY_PROTOCOL, minClientProtocol: LEGACY_PROTOCOL, source: 'global' }
      if (!focus.bindingId) throw new Error('当前电脑绑定信息不完整，请重新连接后检查更新')
      const device = await loadDevice(focus.deviceId, focus.bindingId); assertCurrent()
      if (!device) throw new Error('当前电脑已移除或重新绑定，请重新连接后检查更新')
      expected = device
      const proof = await confirmUpdateServerProtocol(expected, signal); assertCurrent()
      if (proof.deviceId !== focus.deviceId || proof.bindingId !== focus.bindingId) throw new Error('当前电脑身份已变化，请重新检查更新')
      return { serverProtocol: proof.serverProtocol, minClientProtocol: proof.minClientProtocol, source: 'device', deviceId: proof.deviceId }
    },
    async validate() {
      assertCurrent()
      if (focus.kind === 'device') {
        if (!expected || !await runWithCurrentDevice(expected, async () => true)) throw new Error('当前电脑已移除或重新绑定，请重新检查更新')
        assertCurrent()
      }
    },
    dispose
  }
}
