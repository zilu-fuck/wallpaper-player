import { Plus } from 'lucide-react-native'
import { useCallback, useEffect, useState } from 'react'
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native'
import type { NavigationContext } from '../../App'
import { DeviceCard } from '../components/DeviceCard'
import { PrimaryButton } from '../components/PrimaryButton'
import { unpairCurrentDevice } from '../services/api'
import { checkDeviceAvailability, type DeviceAvailability } from '../services/connection-manager'
import { removeDevice } from '../stores/devices'
import type { StoredDevice } from '../types'
import { useTheme } from '../theme-context'

type Props = {
  navigation: NavigationContext
  devices: StoredDevice[]
}

export function DeviceListScreen({ navigation, devices }: Props) {
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const [availabilityById, setAvailabilityById] = useState<Record<string, DeviceAvailability>>({})

  const refreshAvailability = useCallback(() => {
    let cancelled = false
    setAvailabilityById({})
    devices.forEach((device) => {
      checkDeviceAvailability(device)
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
    }
  }, [devices])

  useEffect(() => refreshAvailability(), [refreshAvailability])

  return (
    <View style={styles.shell}>
      <View style={styles.header}>
        <Text style={styles.title}>我的电脑</Text>
        <Text style={styles.subtitle}>选择一台已绑定的 Wallpaper Player。</Text>
      </View>

      <FlatList
        data={devices}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
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
                    if (item.pairedDeviceId) {
                      await unpairCurrentDevice(item).catch(() => {})
                    }
                    await removeDevice(item.id)
                    await navigation.refreshDevices()
                  }
                }
              ])
            }}
          />
        )}
        ListFooterComponent={(
          <PrimaryButton
            label="绑定新电脑"
            icon={<Plus color={colors.onAccent} size={20} />}
            onPress={() => navigation.navigate({ name: 'pair' })}
          />
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
    padding: 20,
    gap: 6
  },
  title: {
    color: colors.text,
    fontSize: 30,
    fontWeight: '800'
  },
  subtitle: {
    color: colors.muted,
    fontSize: 15
  },
  list: {
    padding: 16,
    gap: 12
  }
})
