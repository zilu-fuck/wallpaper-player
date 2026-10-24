import { useLayoutEffect, useState } from 'react'
import { AppContext } from '../context/AppContext'
import { useAppController } from '../hooks/useAppController'
import { ControllerStore } from '../services/controller-store'

export default function AppProvider({ children }) {
  const controller = useAppController()
  const [store] = useState(() => new ControllerStore(controller))
  useLayoutEffect(() => { store.publish(controller) }, [controller, store])
  return <AppContext.Provider value={store}>{children}</AppContext.Provider>
}
