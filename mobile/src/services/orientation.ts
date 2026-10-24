import * as ScreenOrientation from 'expo-screen-orientation'

let revision = 0
let queue: Promise<unknown> = Promise.resolve()

/** Native locks finish in order; superseded requests cannot reset a newer screen. */
export function lockOrientation(mode: 'portrait' | 'landscape'): Promise<boolean> {
  const requested = ++revision
  const result = queue.then(async () => {
    if (requested !== revision) return false
    try {
      await ScreenOrientation.lockAsync(mode === 'landscape'
        ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP)
      return requested === revision
    } catch (error) {
      if (requested !== revision) return false
      throw error
    }
  })
  queue = result.catch(() => {})
  return result
}
