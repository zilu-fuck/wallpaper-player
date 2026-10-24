import type { ReactNode } from 'react'
import { Modal, StyleSheet, View, type ModalProps } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export function AccessibleModal({ children, label, onClose, supportedOrientations }: {
  children: ReactNode; label: string; onClose: () => void; supportedOrientations?: ModalProps['supportedOrientations']
}) {
  return (
    <Modal transparent animationType="none" presentationStyle="overFullScreen" statusBarTranslucent navigationBarTranslucent
      supportedOrientations={supportedOrientations} onRequestClose={onClose}>
      <SafeAreaView style={styles.fill}>
        <View style={styles.fill} accessibilityLabel={label} accessibilityViewIsModal onAccessibilityEscape={onClose}>{children}</View>
      </SafeAreaView>
    </Modal>
  )
}
const styles = StyleSheet.create({ fill: { flex: 1 } })
