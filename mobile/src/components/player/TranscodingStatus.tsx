import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '../../theme'

type Props = {
  progress: number
  queuePosition?: number
  onCancel: () => void
}

export function TranscodingStatus({ progress, queuePosition = 0, onCancel }: Props) {
  const percent = Math.max(1, Math.min(100, Math.round(progress * 100)))
  const queued = queuePosition > 0

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{queued ? `排队中 · 第 ${queuePosition} 位` : '正在准备兼容格式'}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
      <Text style={styles.percent}>{queued ? '等待电脑端转码队列' : `${percent}%`}</Text>
      <Pressable style={styles.cancelButton} onPress={onCancel}>
        <Text style={styles.cancelText}>取消</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 26,
    right: 26,
    top: '37%',
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    gap: 10
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800'
  },
  track: {
    width: '100%',
    height: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden'
  },
  fill: {
    height: '100%',
    borderRadius: 6,
    backgroundColor: colors.accent
  },
  percent: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13,
    fontWeight: '700'
  },
  cancelButton: {
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center'
  },
  cancelText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800'
  }
})
