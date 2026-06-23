import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useCallback, useState } from 'react'
import mobilePackage from '../../package.json'
import { checkMobileUpdate, type MobileUpdateInfo } from '../services/updates'
import { useTheme } from '../theme-context'

const APP_VERSION = mobilePackage.version

export function MobileUpdateCard() {
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<MobileUpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState('')

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true)
    setUpdateError('')
    try {
      setUpdateInfo(await checkMobileUpdate(APP_VERSION))
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : '检查更新失败')
    } finally {
      setChecking(false)
    }
  }, [])

  const handleOpenUpdate = useCallback(() => {
    const targetUrl = updateInfo?.downloadUrl || updateInfo?.releaseUrl
    if (targetUrl) {
      Linking.openURL(targetUrl).catch(() => setUpdateError('无法打开更新页面'))
    }
  }, [updateInfo?.downloadUrl, updateInfo?.releaseUrl])

  return (
    <View style={styles.updateBox}>
      <Text style={styles.versionText}>手机客户端版本 v{APP_VERSION}</Text>
      <Text style={styles.updateTitle}>
        {updateInfo
          ? updateInfo.available
            ? `发现新版本 v${updateInfo.latestVersion}`
            : `已是最新版本 v${updateInfo.currentVersion}`
          : '检查 GitHub Releases 上的最新版本'}
      </Text>
      {updateInfo?.available ? (
        <Text style={styles.updateText}>{updateInfo.releaseName}</Text>
      ) : null}
      {updateError ? <Text style={styles.updateError}>{updateError}</Text> : null}
      <View style={styles.updateActions}>
        <Pressable
          style={[styles.updateButton, checking && styles.updateButtonDisabled]}
          onPress={handleCheckUpdate}
          disabled={checking}
        >
          {checking ? <ActivityIndicator color={colors.onAccent} size="small" /> : null}
          <Text style={styles.updateButtonText}>{checking ? '检查中...' : '检查更新'}</Text>
        </Pressable>
        {updateInfo?.available ? (
          <Pressable style={[styles.updateButton, styles.updateButtonSecondary]} onPress={handleOpenUpdate}>
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
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 12,
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
    fontWeight: '800'
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
    minHeight: 38,
    borderRadius: 8,
    paddingHorizontal: 13,
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
