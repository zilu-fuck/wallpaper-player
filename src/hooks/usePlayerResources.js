import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { emptyProgressPreview, MpvHostController, ProgressPreviewController } from '../services/player-resources'

export function useProgressPreview(intentKey, target) {
  const current = useRef(null)
  const [record, setRecord] = useState(null)
  const controller = useMemo(() => {
    const owner = new ProgressPreviewController(window.electronAPI, target, state => {
      if (current.current === owner) setRecord({ owner, state })
    })
    return owner
  }, [intentKey, target])
  current.current = controller
  useEffect(() => () => controller.dispose(), [controller])
  const showProgressPreview = useCallback((time, x) => controller.show(time, x), [controller])
  const hideProgressPreview = useCallback(() => controller.hide(), [controller])
  return { progressPreview: record?.owner === controller ? record.state : emptyProgressPreview(), showProgressPreview, hideProgressPreview }
}

export function useMpvHost(intentKey, enabled, stageRef, surfaceRef, getAdapter) {
  const controller = useMemo(() => new MpvHostController(() => stageRef.current || surfaceRef.current,
    getAdapter, window, document), [intentKey, stageRef, surfaceRef, getAdapter])
  useLayoutEffect(() => {
    if (enabled) controller.start(typeof ResizeObserver === 'undefined' ? null : ResizeObserver)
    return () => controller.dispose()
  }, [controller, enabled])
  const readMpvHostBounds = useCallback(() => enabled ? controller.readBounds() : null, [controller, enabled])
  const scheduleMpvHostBoundsSync = useCallback((burst = false) => controller.schedule(burst), [controller])
  return { readMpvHostBounds, scheduleMpvHostBoundsSync }
}
