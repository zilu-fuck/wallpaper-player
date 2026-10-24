import { useEffect, useMemo, useRef, useState } from 'react'
import { PluginSettings, initialPluginSettings } from '../services/plugin-settings'

export function usePluginSettings({ plugins, refreshPlugins, active }) {
  const initial = useRef(plugins), owner = useRef(null), refresh = useRef(refreshPlugins)
  refresh.current = refreshPlugins
  const [state, setState] = useState(() => initialPluginSettings(plugins))
  useEffect(() => {
    const controller = new PluginSettings(window.electronAPI, () => refresh.current(), setState, initial.current,
      plugin => window.confirm(`卸载插件“${plugin.name || plugin.id}”？`)); owner.current = controller
    return () => { controller.dispose(); if (owner.current === controller) owner.current = null }
  }, [])
  useEffect(() => { owner.current?.reconcile(plugins) }, [plugins])
  useEffect(() => {
    const visibility = () => owner.current?.setActive(active && document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility); visibility()
    return () => { document.removeEventListener('visibilitychange', visibility); owner.current?.setActive(false) }
  }, [active])
  const actions = useMemo(() => {
    const call = (method, ...args) => owner.current?.[method](...args)
    return { onSelectPlugin: id => call('select', id), onTogglePlugin: (id, enabled) => call('toggle', id, enabled),
      onInstallPluginFile: () => call('install', 'file'), onInstallPluginDirectory: () => call('install', 'directory'),
      onUninstallPlugin: id => call('uninstall', id), onOpenPluginsDirectory: () => call('openDirectory'), onRefreshPlugins: () => call('load', true),
      onDraftChange: (key, value, id) => call('edit', key, value, id), onCommitConfig: (key, value, id) => call('commit', key, value, id), onSaveDraftConfig: id => call('save', undefined, id),
      onPluginUiChange: (patch, id) => call('editUi', patch, id) }
  }, [])
  return { ...state, ...actions }
}
