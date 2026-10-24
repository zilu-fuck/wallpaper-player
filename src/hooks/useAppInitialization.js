import { useCallback, useEffect, useRef, useState } from 'react'
import { AppInitialization, initialAppInitialization } from '../services/app-initialization'
import { getPublicDirectories } from '../utils/directories'

export function useAppInitialization(appState, scan) {
  const [state, setState] = useState(initialAppInitialization), owner = useRef(null)
  useEffect(() => {
    const probe = async (key, method, publish, current) => {
      const revision = appState.getStatusRevision?.(key)
      try {
        const result = await window.electronAPI[method]()
        if (!current() || revision !== appState.getStatusRevision?.(key)) return
        if (!result || typeof result.available !== 'boolean') throw Error(`${key} 检测响应无效`)
        publish(result)
      } catch (error) { if (current() && revision === appState.getStatusRevision?.(key)) throw error }
    }
    const controller = new AppInitialization({
      settings: appState.readSettings, setLoading: appState.setLoading, cancelScan: scan.cancelScan,
      plugins: appState.refreshPlugins,
      scan: async settings => {
        const directories = getPublicDirectories(settings.directories || [], settings.privateDirectories || [])
        const directory = directories.includes(settings.defaultDirectory) ? settings.defaultDirectory : directories[0]
        if (directory) { appState.setCurrentDir(directory); await scan.scanAndLoad(directory) }
      },
      ffmpeg: current => probe('ffmpeg', 'checkFfmpeg', appState.setFfmpegStatus, current),
      mpv: current => probe('mpv', 'checkMpv', appState.setMpvStatus, current)
    }, setState)
    owner.current = controller; void controller.run()
    return () => { controller.dispose(); if (owner.current === controller) owner.current = null }
  }, [])
  useEffect(() => { if (appState.pluginsLoaded) owner.current?.accept('plugins') }, [appState.pluginsLoaded])
  useEffect(() => { if (appState.ffmpegStatus) owner.current?.accept('ffmpeg') }, [appState.ffmpegStatus])
  useEffect(() => { if (appState.mpvStatus) owner.current?.accept('mpv') }, [appState.mpvStatus])
  const retryInitialization = useCallback(key => owner.current?.run(key), [])
  return { ...state, retryInitialization }
}
