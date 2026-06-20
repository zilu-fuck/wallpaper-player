import { AppContext } from '../context/AppContext'
import { useAppController } from '../hooks/useAppController'

export default function AppProvider({ children }) {
  const controller = useAppController()
  return (
    <AppContext.Provider value={controller}>
      {children}
    </AppContext.Provider>
  )
}
