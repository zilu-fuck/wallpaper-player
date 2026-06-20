import { Heart } from 'lucide-react-native'
import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../../theme'
import type { VideoItem } from '../../types'
import { getVideoTitle } from '../../screens/player/playerUtils'

type Props = {
  video: VideoItem
  favorite: boolean
  groupLine: string
  detailLine: string
  bottomOffset: number
}

export function VideoInfo({ video, favorite, groupLine, detailLine, bottomOffset }: Props) {
  return (
    <View style={[styles.infoBlock, { bottom: bottomOffset }]} pointerEvents="none">
      <View style={styles.titleRow}>
        <Text style={styles.videoTitle} numberOfLines={2}>{getVideoTitle(video)}</Text>
        {favorite ? <Heart color={colors.danger} fill={colors.danger} size={15} /> : null}
      </View>
      <Text style={styles.videoMeta} numberOfLines={1}>{groupLine}</Text>
      <Text style={styles.videoDetail} numberOfLines={1}>{detailLine}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  infoBlock: {
    position: 'absolute',
    left: 16,
    width: '70%',
    paddingRight: 10,
    gap: 4
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  videoTitle: {
    flexShrink: 1,
    color: colors.text,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.72)',
    textShadowRadius: 5,
    textShadowOffset: { width: 0, height: 1 }
  },
  videoMeta: {
    color: 'rgba(255,255,255,0.74)',
    fontSize: 12,
    lineHeight: 16,
    textShadowColor: 'rgba(0,0,0,0.72)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 }
  },
  videoDetail: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 11,
    lineHeight: 15,
    textShadowColor: 'rgba(0,0,0,0.72)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 }
  }
})
