import { Heart } from 'lucide-react-native'
import { StyleSheet, View } from 'react-native'
import { colors } from '../../theme'

type Props = {
  visible: boolean
}

export function FavoriteAnimation({ visible }: Props) {
  if (!visible) return null
  return (
    <View style={styles.heartBurst} pointerEvents="none">
      <Heart color={colors.danger} fill={colors.danger} size={94} />
    </View>
  )
}

const styles = StyleSheet.create({
  heartBurst: {
    position: 'absolute',
    alignSelf: 'center',
    top: '39%'
  }
})
