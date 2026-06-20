import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme-context'

type Props = {
  online?: boolean
  text: string
}

export function ConnectionStatus({ online, text }: Props) {
  const { colors } = useTheme()
  const styles = createStyles(colors)

  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: online ? colors.success : colors.warning }]} />
      <Text style={styles.text}>{text}</Text>
    </View>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  text: {
    color: colors.muted,
    fontSize: 13
  }
})
