import { useMemo } from 'react'
import {
  AppActionsContext,
  AppContext
} from '../context/AppContext'
import { useAppController } from '../hooks/useAppController'

// useAppActions() 只消费动作型函数（无状态，稳定引用）。
const ACTION_KEYS = [
  'saveSettings',
  'handleToggleFavorite',
  'handleOpenInFolder',
  'handleSelectDirectory',
  'handleAddDirectory',
  'handleDirectoryChange',
  'handleCheckUpdate',
  'handleOpenTagEditor',
  'handleCloseTagEditor',
  'handleSaveTagEditor',
  'handleSetCustomTags',
  'handleAppendCustomTags',
  'handleToggleVideoSelection',
  'handleSelectOnlyVideo',
  'handleClearVideoSelection',
  'handleOpenBulkTagEditor',
  'handleCloseBulkTagEditor',
  'handleSaveBulkTagEditor',
  'handlePlay',
  'handlePlayPath',
  'handleOpenFile',
  'handlePlayNetworkResource',
  'handleDropFiles',
  'handleClosePlayer',
  'handleStopPlayback',
  'handleNext',
  'handlePrev',
  'handleReplayCurrent',
  'handleAdvanceFromEnd',
  'queueVideoAnalysis',
  'cancelRunningAnalysisTask',
  'retryAnalysisTask',
  'hideFinishedAnalysisTasks',
  'deleteSavedAnalysisTask',
  'deleteSavedAnalysisTasks',
  'refreshSavedAnalysisResults',
  'openAnalysisResultTask',
  'closeAnalysisResultTask'
]

function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, source[key]]))
}

function useControllerSlice(controller, keys) {
  return useMemo(
    () => pick(controller, keys),
    keys.map(key => controller[key])
  )
}

export default function AppProvider({ children }) {
  const controller = useAppController()
  const actionsValue = useControllerSlice(controller, ACTION_KEYS)

  return (
    <AppContext.Provider value={controller}>
      <AppActionsContext.Provider value={actionsValue}>
        {children}
      </AppActionsContext.Provider>
    </AppContext.Provider>
  )
}
