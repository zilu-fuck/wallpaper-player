import { Plus } from 'lucide-react-native'
import { useCallback, useEffect, useState } from 'react'
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native'
import type { NavigationContext } from '../../App'
import { DeviceCard } from '../components/DeviceCard'
import { MobileUpdateCard } from '../components/MobileUpdateCard'
import { PrimaryButton } from '../components/PrimaryButton'
import { unpairCurrentDevice } from '../services/api'
import { checkDeviceAvailability, type DeviceAvailability } from '../services/connection-manager'
import { removeDevice } from '../persistence/devices'
import type { StoredDevice } from '../types'
import { useTheme } from '../theme-context'
import { usePageActivity } from '../hooks/usePageActivity'

type Props = {
  navigation: NavigationContext
  devices: StoredDevice[]
}

export function DeviceListScreen({ navigation, devices }: Props) {
  const pageActive = usePageActivity()
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const [availabilityById, setAvailabilityById] = useState<Record<string, DeviceAvailability>>({})

  const refreshAvailability = useCallback(() => {
    const controller = new AbortController()
    let cancelled = false
    setAvailabilityById({})
    devices.forEach((device) => {
      checkDeviceAvailability(device, controller.signal)
        .then((availability) => {
          if (cancelled) return
          setAvailabilityById(current => ({ ...current, [device.id]: availability }))
        })
        .catch(() => {
          if (cancelled) return
          setAvailabilityById(current => ({
            ...current,
            [device.id]: { state: 'offline', text: '离线' }
          }))
        })
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [devices])

  useEffect(() => { if (pageActive) return refreshAvailability() }, [refreshAvailability, pageActive])

  return (
    <View style={styles.shell}>
      <FlatList
        accessibilityLabel="已绑定电脑"
        data={devices}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={(
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>我的电脑</Text>
            <Text style={styles.subtitle}>选择一台已绑定的 Wallpaper Player。</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <DeviceCard
            device={item}
            availability={availabilityById[item.id]}
            onOpen={() => navigation.navigate({ name: 'library', device: item })}
            onRemove={() => {
              Alert.alert('移除设备', `移除 ${item.name}？`, [
                { text: '取消', style: 'cancel' },
                {
                  text: '移除',
                  style: 'destructive',
                  onPress: async () => {
                    let revokeError = ''
                    if (item.pairedDeviceId) {
                      try { await unpairCurrentDevice(item) } catch {
                        revokeError = '未能通知电脑取消授权。请在电脑端的已绑定设备中移除此手机。'
                      }
                    }
                    try {
                      await removeDevice(item.id, item.bindingId)
                      await navigation.refreshDevices()
                      if (revokeError) Alert.alert('已在手机移除', revokeError)
                    } catch (error) {
                      Alert.alert('设备清理失败', error instanceof Error ? error.message : '请重试')
                      await navigation.refreshDevices().catch(() => {})
                    }
                  }
                }
              ], { cancelable: true })
            }}
          />
        )}
        ListFooterComponent={(
          <View style={styles.footer}>
            <MobileUpdateCard />
            <PrimaryButton
              label="绑定新电脑"
              icon={<Plus color={colors.onAccent} size={20} />}
              onPress={() => navigation.navigate({ name: 'pair' })}
            />
          </View>
        )}
      />
    </View>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.background
  },
  header: {
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 14,
    gap: 6
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0.4
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20
  },
  list: {
    padding: 16,
    paddingTop: 8,
    gap: 12
  },
  footer: {
    gap: 12,
    paddingTop: 4
  }
})
