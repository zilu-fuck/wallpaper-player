import { createContext, useContext } from 'react'

// 注意：历史版本曾拆分 6 个按域的切片 Context（AppState/Library/Filter/...），
// 但实际消费点始终只有 useApp() 与 useAppActions()，切片从未被使用，
// 反而每次 render 都额外构造 6 个 memo 对象。现已删除，只保留两个真实 Context。

export const AppContext = createContext(null)
export const AppActionsContext = createContext(null)

function useRequiredContext(context, name) {
  const ctx = useContext(context)
  if (!ctx) throw new Error(`${name} must be used inside <AppProvider>`)
  return ctx
}

export function useApp() {
  return useRequiredContext(AppContext, 'useApp')
}

export function useAppActions() {
  return useRequiredContext(AppActionsContext, 'useAppActions')
}
