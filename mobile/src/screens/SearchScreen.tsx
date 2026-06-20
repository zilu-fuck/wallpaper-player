import { ArrowLeft, Search } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { NavigationContext } from '../../App'
import { VideoCard } from '../components/VideoCard'
import { useTheme } from '../theme-context'
import type { StoredDevice, VideoItem } from '../types'
import { safeSearchText } from '../utils/url'

type Props = {
  navigation: NavigationContext
  device: StoredDevice
  videos: VideoItem[]
}

export function SearchScreen({ navigation, device, videos }: Props) {
  const { colors } = useTheme()
  const styles = createStyles(colors)
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return videos
    return videos.filter(video => safeSearchText(video.name, video.fileName, video.group, video.tags).includes(keyword))
  }, [query, videos])

  return (
    <View style={styles.shell}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => navigation.navigate({ name: 'library', device })}>
          <ArrowLeft color={colors.text} size={22} />
        </Pressable>
        <View style={styles.searchBox}>
          <Search color={colors.muted} size={20} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="搜索名称、分组、标签"
            placeholderTextColor={colors.subtle}
            style={styles.input}
          />
        </View>
      </View>

      <FlatList
        data={results}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <VideoCard
            device={device}
            video={item}
            onPress={() => navigation.navigate({ name: 'player', device, video: item, videos })}
          />
        )}
        ListEmptyComponent={(
          <View style={styles.empty}>
            <Text style={styles.emptyText}>没有匹配的视频</Text>
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
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchBox: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16
  },
  list: {
    padding: 12,
    gap: 10
  },
  empty: {
    padding: 32,
    alignItems: 'center'
  },
  emptyText: {
    color: colors.muted
  }
})
