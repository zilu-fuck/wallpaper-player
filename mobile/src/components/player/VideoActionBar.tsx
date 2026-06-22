import { Brain, Download, Heart, MonitorPlay, MoreHorizontal, Tags } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ReactNode } from 'react'
import { colors } from '../../theme'
import { HIT_SLOP } from '../../screens/player/playerLayout'

type Props = {
  favorite: boolean
  analysisLabel?: string
  analysisActive?: boolean
  bottomOffset: number
  onFavorite: () => void
  onTags: () => void
  onAnalysis: () => void
  onCache: () => void
  onDesktopPlay: () => void
  onMore: () => void
}

type ActionButtonProps = {
  label: string
  icon: ReactNode
  active?: boolean
  activeColor?: string
  onPress: () => void
}

function ActionButton({ label, icon, active = false, activeColor = colors.accent, onPress }: ActionButtonProps) {
  return (
    <Pressable style={styles.actionButton} onPress={onPress} hitSlop={HIT_SLOP}>
      <View style={[styles.actionIconWrap, active && { backgroundColor: `${activeColor}2e` }]}>
        {icon}
        {active ? <View style={[styles.actionDot, { backgroundColor: activeColor }]} /> : null}
      </View>
      <Text style={[styles.actionLabel, active && { color: activeColor }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

export function VideoActionBar({
  favorite,
  analysisLabel = '分析',
  analysisActive = false,
  bottomOffset,
  onFavorite,
  onTags,
  onAnalysis,
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
        activeColor={colors.danger}
        onPress={onFavorite}
      />
      <ActionButton label="标签" icon={<Tags color={colors.text} size={24} />} onPress={onTags} />
      <ActionButton
        label={analysisLabel}
        icon={<Brain color={analysisActive ? colors.accent : colors.text} size={23} />}
        active={analysisActive}
        activeColor={colors.accent}
        onPress={onAnalysis}
      />
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
    gap: 11
  },
  actionButton: {
    width: 54,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  actionIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)'
  },
  actionDot: {
    position: 'absolute',
    right: 4,
    top: 4,
    width: 7,
    height: 7,
    borderRadius: 4
  },
  actionLabel: {
    width: 62,
    color: 'rgba(255,255,255,0.88)',
    fontSize: 10.5,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 }
  }
})
