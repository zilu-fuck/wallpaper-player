import { useCallback, useEffect, useRef, useState } from 'react'
import { DownloadStateObserver } from '../services/download-state-observer'

export function useDownloadStateObserver(onError, { active = true } = {}) {
  const [state, setState] = useState({ engine: null, tasks: [] }), owner = useRef(null)
  const activeRef = useRef(active); activeRef.current = active
  useEffect(() => {
    const observer = new DownloadStateObserver(window.electronAPI, { onState: setState, onError })
    owner.current = observer
    const visibility = () => observer.setActive(activeRef.current && document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility); visibility()
    return () => { document.removeEventListener('visibilitychange', visibility); observer.dispose(); if (owner.current === observer) owner.current = null }
  }, [onError])
  useEffect(() => { owner.current?.setActive(active && document.visibilityState !== 'hidden') }, [active])
  const publish = useCallback(value => owner.current?.publishMutation(value), [])
  const refreshState = useCallback(options => owner.current?.refresh(options) || Promise.resolve(null), [])
  return { state, setState: publish, refreshState }
}
