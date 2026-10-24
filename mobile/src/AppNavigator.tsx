import { StyleSheet, View } from 'react-native'
import type { NavigationContext } from '../App'
import type { AppRoute } from './services/navigation-store'
import { DeviceListScreen } from './screens/DeviceListScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { PairDeviceScreen } from './screens/PairDeviceScreen'
import { PlayerScreen } from './screens/PlayerScreen'
import { SearchScreen } from './screens/SearchScreen'

export type { AppRoute } from './services/navigation-store'

export function AppNavigator({ context }: { context: NavigationContext }) {
  const { stack, route: current, resources } = context
  const renderRoute = (route: AppRoute, focused: boolean) => {
    if (route.name === 'devices') return <DeviceListScreen navigation={context} devices={resources.getDevices()} />
    if (route.name === 'pair') return <PairDeviceScreen navigation={context} />
    const device = resources.getDevice(route)
    if (!device) return null
    if (route.name === 'library') return <LibraryScreen navigation={context} device={device} focused={focused} />
    const videos = resources.getPlaylist(route)
    if (route.name === 'search') return <SearchScreen navigation={context} device={device} videos={videos} />
    if (route.name === 'player') {
      const video = videos.find(item => item.id === route.videoId)
      return video ? <PlayerScreen navigation={context} device={device} video={video} videos={videos} focused={focused} /> : null
    }
    return null
  }
  return (
    <View style={styles.stack}>
      {stack.filter(route => route.key === current.key || route.name === 'library' || route.name === 'search').map(route => {
        const focused = route.key === current.key
        return (
          <View key={route.key} style={StyleSheet.absoluteFill} pointerEvents={focused ? 'auto' : 'none'}
            accessibilityElementsHidden={!focused} importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}>
            {renderRoute(route, focused)}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({ stack: { flex: 1 } })
