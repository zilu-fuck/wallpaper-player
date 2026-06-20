import { StyleSheet, View } from 'react-native'
import type { NavigationContext } from '../App'
import type { StoredDevice, VideoItem } from './types'
import { DeviceListScreen } from './screens/DeviceListScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { PairDeviceScreen } from './screens/PairDeviceScreen'
import { PlayerScreen } from './screens/PlayerScreen'
import { SearchScreen } from './screens/SearchScreen'

export type AppRoute =
  | { name: 'loading' }
  | { name: 'pair' }
  | { name: 'devices', devices: StoredDevice[] }
  | { name: 'library', device: StoredDevice }
  | { name: 'search', device: StoredDevice, videos: VideoItem[] }
  | { name: 'player', device: StoredDevice, video: VideoItem, videos: VideoItem[] }

type Props = {
  context: NavigationContext
}

export function AppNavigator({ context }: Props) {
  const { route, previousRoute } = context
  const stackedLibraryRoute = route.name === 'library'
    ? route
    : route.name === 'player' && previousRoute?.name === 'library'
      ? previousRoute
      : null

  if (stackedLibraryRoute) {
    return (
      <View style={styles.stack}>
        <View style={StyleSheet.absoluteFill}>
          <LibraryScreen navigation={context} device={stackedLibraryRoute.device} />
        </View>
        {route.name === 'player' ? (
          <View style={StyleSheet.absoluteFill}>
            <PlayerScreen navigation={context} device={route.device} video={route.video} videos={route.videos} />
          </View>
        ) : null}
      </View>
    )
  }

  switch (route.name) {
    case 'devices':
      return <DeviceListScreen navigation={context} devices={route.devices} />
    case 'search':
      return <SearchScreen navigation={context} device={route.device} videos={route.videos} />
    case 'player':
      return <PlayerScreen navigation={context} device={route.device} video={route.video} videos={route.videos} />
    case 'pair':
    default:
      return <PairDeviceScreen navigation={context} />
  }
}

const styles = StyleSheet.create({
  stack: {
    flex: 1
  }
})
