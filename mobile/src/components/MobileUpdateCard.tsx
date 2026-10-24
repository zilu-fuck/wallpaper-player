import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useCallback, useEffect, useRef, useState } from 'react'
import mobilePackage from '../../package.json'
import { checkMobileUpdate, type MobileUpdateInfo } from '../services/updates'
import { getActiveDeviceContext, subscribeActiveDeviceContext } from '../services/active-device-context'
import { loadDevice, subscribeDeviceChanges } from '../persistence/devices'
import { usePageActivity } from '../hooks/usePageActivity'
import { useTheme } from '../theme-context'

const APP_VERSION = mobilePackage.version

export function MobileUpdateCard({ focused = true }: { focused?: boolean }) {
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<MobileUpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState('')
  const pageActive = usePageActivity(focused)
  const owner = useRef({ active: false, generation: 0, scope: getActiveDeviceContext(), controller: null as AbortController | null,
    completed: null as MobileUpdateInfo | null })

  useEffect(() => {
    const current = owner.current
    current.active = pageActive
    const reset = () => {
      current.generation++
      current.controller?.abort()
      current.controller = null
      current.completed = null
      current.scope = getActiveDeviceContext()
      setChecking(false)
      setUpdateInfo(null)
      setUpdateError('')
    }
    reset()
    const unsubscribeNavigation = subscribeActiveDeviceContext(reset)
    const unsubscribeBinding = subscribeDeviceChanges(change => {
      const scope = current.scope
      if (scope.kind === 'device' && scope.deviceId === change.deviceId && scope.bindingId === change.previousBindingId) reset()
    })
    return () => {
      current.active = false
      current.generation++
      current.controller?.abort()
      current.controller = null
      current.completed = null
      unsubscribeNavigation()
      unsubscribeBinding()
    }
  }, [pageActive])

  const isCurrent = useCallback((generation: number) => {
    const current = owner.current
    return current.active && current.generation === generation && current.scope === getActiveDeviceContext()
  }, [])

  const handleCheckUpdate = useCallback(async () => {
    const current = owner.current
    if (!current.active) return
    current.controller?.abort()
    const controller = new AbortController()
    const generation = ++current.generation
    current.controller = controller
    current.completed = null
    current.scope = getActiveDeviceContext()
    setChecking(true)
    setUpdateInfo(null)
    setUpdateError('')
    try {
      const info = await checkMobileUpdate(APP_VERSION, { signal: controller.signal })
      if (isCurrent(generation)) { current.completed = info; setUpdateInfo(info) }
    } catch (err) {
      if (isCurrent(generation) && !controller.signal.aborted) setUpdateError(err instanceof Error ? err.message : '检查更新失败')
    } finally {
      if (isCurrent(generation)) { current.controller = null; setChecking(false) }
    }
  }, [isCurrent])

  const handleOpenUpdate = useCallback(async () => {
    const targetUrl = updateInfo?.downloadUrl || updateInfo?.releaseUrl
    const { generation, scope } = owner.current
    if (!targetUrl || owner.current.completed !== updateInfo || !isCurrent(generation)) return
    try {
      if (scope.kind === 'device' && (!scope.bindingId || !await loadDevice(scope.deviceId, scope.bindingId))) {
        if (isCurrent(generation)) { owner.current.completed = null; setUpdateInfo(null); setUpdateError('当前电脑绑定已变化，请重新检查更新') }
        return
      }
      if (isCurrent(generation)) await Linking.openURL(targetUrl)
    } catch {
      if (isCurrent(generation)) setUpdateError('无法打开更新页面')
    }
  }, [updateInfo?.downloadUrl, updateInfo?.releaseUrl, isCurrent])

  return (
    <View style={styles.updateBox}>
      <Text style={styles.versionText}>手机客户端版本 v{APP_VERSION}</Text>
      <Text style={styles.updateTitle} accessibilityLiveRegion="polite">
        {updateInfo
          ? updateInfo.available
            ? `发现新版本 v${updateInfo.latestVersion}`
            : `已是最新版本 v${updateInfo.currentVersion}`
          : '检查 GitHub Releases 上的最新版本'}
      </Text>
      {updateInfo?.available ? (
        <Text style={styles.updateText}>{updateInfo.releaseName}</Text>
      ) : null}
      {updateError ? <Text style={styles.updateError} accessibilityRole="alert">{updateError}</Text> : null}
      <View style={styles.updateActions}>
        <Pressable
          style={[styles.updateButton, checking && styles.updateButtonDisabled]}
          onPress={handleCheckUpdate}
          disabled={checking || !pageActive}
          accessibilityRole="button"
          accessibilityLabel="检查更新"
          accessibilityState={{ disabled: checking || !pageActive, busy: checking }}
        >
          {checking ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
          <Text style={styles.updateButtonText}>{checking ? '检查中...' : '检查更新'}</Text>
        </Pressable>
        {updateInfo?.available ? (
          <Pressable style={[styles.updateButton, styles.updateButtonSecondary]} onPress={handleOpenUpdate} accessibilityRole="button"
            accessibilityLabel={updateInfo.downloadUrl ? '下载更新' : '查看更新'}>
            <Text style={[styles.updateButtonText, styles.updateButtonSecondaryText]}>
              {updateInfo.downloadUrl ? '下载更新' : '查看更新'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  updateBox: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 8
  },
  versionText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19
  },
  updateTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20
  },
  updateText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19
  },
  updateError: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 19
  },
  updateActions: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap'
  },
  updateButton: {
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: colors.accentStrong
  },
  updateButtonSecondary: {
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border
  },
  updateButtonDisabled: {
    opacity: 0.62
  },
  updateButtonText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '800'
  },
  updateButtonSecondaryText: {
    color: colors.text
  }
})
