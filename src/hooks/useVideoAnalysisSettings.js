import { useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisSettings, initialAnalysisSettings } from '../services/analysis-settings'

export function useVideoAnalysisSettings({ enabled, active, settings }) {
  const initial = useRef(settings), owner = useRef(null)
  const [state, setState] = useState(() => initialAnalysisSettings(settings))
  useEffect(() => {
    const controller = new AnalysisSettings(window.electronAPI, setState, initial.current)
    owner.current = controller
    const event = () => { if (controller.enabled && controller.active && controller.view.analysisRuntimeLoaded) void controller.observer.refresh() }
    const unsubscribe = window.electronAPI.onVideoAnalysisVlmEvent?.(event)
    return () => { unsubscribe?.(); controller.dispose(); if (owner.current === controller) owner.current = null }
  }, [])
  useEffect(() => { owner.current?.setEnabled(enabled) }, [enabled])
  useEffect(() => { owner.current?.reconcileSettings(settings) }, [settings])
  useEffect(() => {
    const visibility = () => owner.current?.setActive(active && document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility); visibility()
    return () => { document.removeEventListener('visibilitychange', visibility); owner.current?.setActive(false) }
  }, [active])
  const actions = useMemo(() => {
    const call = (method, ...args) => owner.current?.[method](...args)
    return {
      onSelectAnalysisOutputDir: () => call('selectOutput'), onOpenAnalysisOutputDir: () => call('openDirectory', false),
      onSelectAnalysisModelDir: () => call('selectDirectory'), onOpenAnalysisModelDir: () => call('openDirectory', true),
      onAnalysisRuntimeChange: (key, value) => call('edit', key, value), onVlmRuntimeChange: (key, value) => call('edit', key, value),
      onLlmProviderChange: value => call('provider', value), onSelectedVlmModelChange: value => call('selectModel', value),
      onSelectedVlmPrecisionChange: value => owner.current?.update({ selectedVlmPrecision: value }),
      onSaveVlmConfig: (patch, options) => call('saveVlm', patch, options), onSaveAnalysisRuntimeConfig: () => call('save'),
      onResetAnalysisRuntimeConfig: () => call('reset'), onReloadAnalysisRuntimeConfig: () => call('load'),
      onDownloadVlmModel: () => call('download'), onCancelVlmDownload: () => call('cancelDownload'),
      onStartVlmService: () => call('start'), onStopVlmService: () => call('stop'), onRefreshVlmState: () => call('refresh'),
      onSelectVlmModelFile: () => call('selectModelFile'), onListLocalVlmFiles: () => call('listModels'),
      onSelectLocalVlmFile: file => call('selectLocalModel', file), onSelectVlmServerExecutable: () => call('selectServer')
    }
  }, [])
  return { ...state, ...actions }
}
