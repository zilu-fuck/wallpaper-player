import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

export function useAccessibilityPreferences() {
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)
  useEffect(() => {
    let active = true, readerRevision = 0, motionRevision = 0
    const reader = AccessibilityInfo.addEventListener('screenReaderChanged', value => {
      if (!active) return
      readerRevision++; setScreenReaderEnabled(value)
    })
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      if (!active) return
      motionRevision++; setReduceMotion(value)
    })
    void AccessibilityInfo.isScreenReaderEnabled().then(value => {
      if (active && readerRevision === 0) setScreenReaderEnabled(value)
    }).catch(() => {})
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (active && motionRevision === 0) setReduceMotion(value)
    }).catch(() => {})
    return () => { active = false; reader.remove(); motion.remove() }
  }, [])
  return { screenReaderEnabled, reduceMotion }
}
