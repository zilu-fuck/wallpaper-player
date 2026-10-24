import { useEffect, useRef } from 'react'
import { DownloadSubmission } from '../services/download-submission'
export function useDownloadSubmission() {
  const current = useRef(null)
  const facade = useRef(null)
  if (!current.current || current.current.disposed) current.current = new DownloadSubmission(window.electronAPI)
  if (!facade.current) facade.current = { submit: (...args) => current.current.submit(...args), newIntent: () => current.current.newIntent() }
  useEffect(() => {
    if (current.current.disposed) current.current = new DownloadSubmission(window.electronAPI)
    const owner = current.current
    return () => owner.dispose()
  }, [])
  return facade.current
}
