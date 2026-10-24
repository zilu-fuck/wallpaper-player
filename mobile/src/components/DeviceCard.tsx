import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Monitor, Trash2 } from 'lucide-react-native'
import type { StoredDevice } from '../types'
import { useTheme } from '../theme-context'
import type { DeviceAvailability } from '../services/connection-manager'

type Props = {
  device: StoredDevice
  availability?: DeviceAvailability
  onOpen: () => void
  onRemove: () => void
}

export function DeviceCard({ device, availability, onOpen, onRemove }: Props) {
  const { colors } = useTheme()
  const { fontScale = 1 } = useWindowDimensions()
  const styles = createStyles(colors)
  const state = availability?.state || 'unknown'
  const statusText = availability?.text || '检测中'
  const lastConnected = device.lastConnectedAt ? `上次连接 ${new Date(device.lastConnectedAt).toLocaleString()}` : '尚未连接'

  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${device.name}，${statusText}，${device.endpoint}，${lastConnected}`}
        style={({ pressed }) => [styles.open, pressed && styles.pressed]} onPress={onOpen}>
        {fontScale < 1.5 ? <View style={styles.iconBox}>
          <Monitor color={colors.accent} size={24} />
        </View> : null}
        <View style={styles.body}>
          <Text style={styles.name}>{device.name}</Text>
          <Text style={styles.endpoint}>{device.endpoint}</Text>
          <Text style={styles.meta}>{lastConnected}</Text>
          <View style={[
            styles.statusBadge,
            state === 'online' && styles.statusOnline,
            state === 'offline' && styles.statusOffline,
            (state === 'unauthorized' || state === 'mismatch') && styles.statusDanger
          ]}>
            <Text style={[
              styles.statusText,
              state === 'online' && styles.statusOnlineText,
              (state === 'unauthorized' || state === 'mismatch') && styles.statusDangerText
            ]}>
              {statusText}
            </Text>
          </View>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`移除 ${device.name}`} style={styles.remove} onPress={onRemove}>
        <Trash2 color={colors.danger} size={20} />
      </Pressable>
    </View>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  card: {
    minHeight: 96,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'flex-start',
    overflow: 'hidden'
  },
  open: {
    flex: 1,
    minWidth: 0,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12
  },
  pressed: {
    backgroundColor: colors.surfaceElevated
  },
  iconBox: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 6
  },
  name: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700'
  },
  endpoint: {
    color: colors.muted,
    fontSize: 13
  },
  meta: {
    color: colors.subtle,
    fontSize: 12
  },
  statusBadge: {
    minWidth: 56,
    minHeight: 28,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statusText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '800'
  },
  statusOnline: {
    backgroundColor: 'rgba(88,214,141,0.14)'
  },
  statusOffline: {
    backgroundColor: 'rgba(255,255,255,0.08)'
  },
  statusDanger: {
    backgroundColor: 'rgba(255,107,107,0.14)'
  },
  statusOnlineText: {
    color: colors.success
  },
  statusDangerText: {
    color: colors.danger
  },
  remove: {
    width: 48,
    height: 48,
    marginTop: 4,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
