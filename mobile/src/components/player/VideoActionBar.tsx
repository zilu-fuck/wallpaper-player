import { Download, Heart, MonitorPlay, MoreHorizontal, Tags } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ReactNode } from 'react'
import { colors } from '../../theme'
import { HIT_SLOP } from '../../screens/player/playerLayout'

type Props = {
  favorite: boolean
  bottomOffset: number
  onFavorite: () => void
  onTags: () => void
  onCache: () => void
  onDesktopPlay: () => void
  onMore: () => void
}

type ActionButtonProps = {
  label: string
  icon: ReactNode
  active?: boolean
  onPress: () => void
}

function ActionButton({ label, icon, active = false, onPress }: ActionButtonProps) {
  return (
    <Pressable style={styles.actionButton} onPress={onPress} hitSlop={HIT_SLOP}>
      <View style={[styles.actionIconWrap, active && styles.actionIconActive]}>
        {icon}
      </View>
      <Text style={[styles.actionLabel, active && styles.actionLabelActive]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

export function VideoActionBar({
  favorite,
  bottomOffset,
  onFavorite,
  onTags,
  onCache,
  onDesktopPlay,
  onMore
}: Props) {
  return (
    <View style={[styles.rightActions, { bottom: bottomOffset }]} pointerEvents="box-none">
      <ActionButton
        label="收藏"
        icon={<Heart color={favorite ? colors.danger : colors.text} fill={favorite ? colors.danger : 'transparent'} size={25} />}
        active={favorite}
        onPress={onFavorite}
      />
      <ActionButton label="标签" icon={<Tags color={colors.text} size={24} />} onPress={onTags} />
      <ActionButton label="缓存" icon={<Download color={colors.text} size={24} />} onPress={onCache} />
      <ActionButton label="电脑播放" icon={<MonitorPlay color={colors.text} size={24} />} onPress={onDesktopPlay} />
      <ActionButton label="更多" icon={<MoreHorizontal color={colors.text} size={25} />} onPress={onMore} />
    </View>
  )
}

const styles = StyleSheet.create({
  rightActions: {
    position: 'absolute',
    right: 12,
    alignItems: 'center',
    gap: 15
  },
  actionButton: {
    minWidth: 48,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  actionIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.34)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  actionIconActive: {
    backgroundColor: 'rgba(255,59,92,0.2)'
  },
  actionLabel: {
    maxWidth: 62,
    color: 'rgba(255,255,255,0.88)',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 }
  },
  actionLabelActive: {
    color: colors.danger
  }
})
