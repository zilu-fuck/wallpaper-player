import { RefreshCw } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '../../theme'

type Props = {
  error: string
  onRetry: () => void
  onTranscode: () => void
  onDetails: () => void
}

function getErrorCopy(error: string) {
  if (/response code:\s*416|range/i.test(error)) {
    return {
      title: '视频流请求异常',
      subtitle: '电脑端返回的字节范围无效，请重试或刷新视频库。'
    }
  }
  if (/response code:\s*(401|403)|unauthorized|forbidden/i.test(error)) {
    return {
      title: '播放授权已失效',
      subtitle: '请返回设备页重新连接，或重新扫码绑定电脑。'
    }
  }
  return {
    title: '当前格式无法直接播放',
    subtitle: error ? '可能是编码不兼容，或电脑服务暂时不可用。' : '请重试或准备兼容格式。'
  }
}

export function VideoErrorState({ error, onRetry, onTranscode, onDetails }: Props) {
  const copy = getErrorCopy(error)

  return (
    <View style={styles.errorState}>
      <Text style={styles.errorTitle}>{copy.title}</Text>
      <Text style={styles.errorSubtitle} numberOfLines={2}>
        {copy.subtitle}
      </Text>
      <View style={styles.errorActions}>
        <Pressable style={styles.errorButton} onPress={onTranscode}>
          <Text style={styles.errorButtonText}>尝试转码播放</Text>
        </Pressable>
        <Pressable style={styles.errorButton} onPress={onRetry}>
          <RefreshCw color={colors.text} size={16} />
          <Text style={styles.errorButtonText}>重试</Text>
        </Pressable>
        <Pressable style={styles.errorButton} onPress={onDetails}>
          <Text style={styles.errorButtonText}>查看详情</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  errorState: {
    position: 'absolute',
    left: 26,
    right: 26,
    top: '34%',
    paddingHorizontal: 16,
    paddingVertical: 18,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.66)',
    alignItems: 'center',
    gap: 10
  },
  errorTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center'
  },
  errorSubtitle: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19
  },
  errorActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8
  },
  errorButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  errorButtonText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700'
  }
})
