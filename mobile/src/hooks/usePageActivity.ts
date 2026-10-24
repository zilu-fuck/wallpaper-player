import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

export function usePageActivity(focused = true) {
  const [appActive, setAppActive] = useState(!AppState.currentState || AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', status => setAppActive(status === 'active'))
    return () => subscription.remove()
  }, [])
  return focused && appActive
}
