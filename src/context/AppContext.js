import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { shallowEqual } from '../services/controller-store'

export const AppContext = createContext(null)

function useRequiredContext(context, name) {
  const ctx = useContext(context)
  if (!ctx) throw new Error(`${name} must be used inside <AppProvider>`)
  return ctx
}

export function useAppSelection(select, equal = shallowEqual) {
  const store = useRequiredContext(AppContext, 'useAppSelection')
  const committed = useRef({ initialized: false, value: undefined })
  const getSelected = useMemo(() => {
    let initialized = false, previous
    return () => {
      const next = select(store.getSnapshot())
      if (initialized && equal(previous, next)) return previous
      previous = !initialized && committed.current.initialized && equal(committed.current.value, next) ? committed.current.value : next
      initialized = true
      return previous
    }
  }, [store, select, equal])
  const selected = useSyncExternalStore(store.subscribe, getSelected, getSelected)
  useEffect(() => { committed.current = { initialized: true, value: selected } }, [selected])
  return selected
}

// Callers provide a fixed list of field names; action references stay stable across commits.
export function useAppFields(keys) {
  const select = useMemo(() => state => Object.fromEntries(keys.map(key => [key, state[key]])), keys)
  return useAppSelection(select)
}

export function useAppActions() {
  return useRequiredContext(AppContext, 'useAppActions').actions
}
