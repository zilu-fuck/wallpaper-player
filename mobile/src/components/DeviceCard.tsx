import { Pressable, StyleSheet, Text, View } from 'react-native'
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
  const styles = createStyles(colors)
  const state = availability?.state || 'unknown'

  return (
    <Pressable style={({ pressed }) => [styles.card, pressed && styles.pressed]} onPress={onOpen}>
      <View style={styles.iconBox}>
        <Monitor color={colors.accent} size={24} />
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>{device.name}</Text>
        <Text style={styles.endpoint} numberOfLines={1}>{device.endpoint}</Text>
        <Text style={styles.meta}>
          {device.lastConnectedAt ? `上次连接 ${new Date(device.lastConnectedAt).toLocaleString()}` : '尚未连接'}
        </Text>
      </View>
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
          {availability?.text || '检测中'}
        </Text>
      </View>
      <Pressable style={styles.remove} onPress={onRemove} hitSlop={10}>
        <Trash2 color={colors.danger} size={20} />
      </Pressable>
    </Pressable>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  card: {
    minHeight: 96,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  pressed: {
    backgroundColor: colors.surfaceElevated
  },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center'
  },
  body: {
    flex: 1,
    gap: 3
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
    minHeight: 30,
    borderRadius: 15,
    paddingHorizontal: 9,
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
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
