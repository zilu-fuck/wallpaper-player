import { useEffect, useMemo, useRef, useState } from 'react'
import { RemoteSettings, initialRemoteSettings } from '../services/remote-settings'

export function useRemoteSettings(settings) {
  const initial = useRef(settings), owner = useRef(null)
  const [state, setState] = useState(() => initialRemoteSettings(settings))
  useEffect(() => {
    const controller = new RemoteSettings(window.electronAPI, setState, initial.current); owner.current = controller
    const remove = window.electronAPI.onRemoteAccessState?.(value => {
      try { controller.event(value) } catch (error) { controller.update({ remoteError: error.message }) }
    })
    const visibility = () => controller.setActive(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility); visibility()
    return () => { remove?.(); document.removeEventListener('visibilitychange', visibility); controller.dispose(); if (owner.current === controller) owner.current = null }
  }, [])
  useEffect(() => { owner.current?.reconcile(settings) }, [settings])
  const actions = useMemo(() => {
    const call = (method, ...args) => owner.current?.[method](...args)
    return { setRemotePort: value => call('editPort', value), handleRemoteSave: patch => call('save', patch), refreshRemote: () => call('refresh'),
      handleCopyEndpoint: () => call('action', 'copy-endpoint', 'remoteCopyEndpoint', [], '地址已复制'),
      handleCopyToken: () => call('action', 'copy-token', 'remoteCopyToken', [], 'Token 已复制'),
      handleRotateToken: () => call('action', 'rotate', 'remoteRotateToken', [], 'Token 已更新'),
      handleCreatePairingCode: () => call('action', 'pair', 'remoteCreatePairingCode'), handleCopyPairingCode: () => call('copyPairing'),
      handleRemovePairedDevice: id => call('action', 'remove:' + id, 'remoteRemovePairedDevice', [id], '设备已移除'),
      handleApprovePairingRequest: id => call('action', 'approve:' + id, 'remoteApprovePairingRequest', [id], '已允许绑定'),
      handleRejectPairingRequest: id => call('action', 'reject:' + id, 'remoteRejectPairingRequest', [id], '已拒绝绑定') }
  }, [])
  return { ...state, ...actions }
}
