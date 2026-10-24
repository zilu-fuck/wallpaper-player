import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { KeyboardAvoidingView, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { X } from 'lucide-react-native'
import { useTheme } from '../../theme-context'

export function PlayerSheetFrame({ title, onClose, notice, children, footer }: {
  title: string; onClose: () => void; notice?: string; children: ReactNode; footer?: ReactNode
}) {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const drag = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 16 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderRelease: (_event, gesture) => { if (gesture.dy > 48) onClose() }
  }), [onClose])
  return (
    <KeyboardAvoidingView style={styles.fill} behavior="padding"
      keyboardVerticalOffset={insets.top + (Platform.OS === 'android' ? insets.bottom : 0)}>
      <Pressable accessible={false} importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header} {...drag.panHandlers}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}`} onPress={onClose}
            style={[styles.close, { backgroundColor: colors.surfaceElevated }]}><X color={colors.text} size={22} /></Pressable>
        </View>
        {notice ? <ScrollView style={styles.noticeScroll} keyboardShouldPersistTaps="handled">
          <Text accessibilityLiveRegion="polite" style={[styles.notice, { color: colors.text, backgroundColor: colors.surfaceElevated }]}>{notice}</Text>
        </ScrollView> : null}
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
        {footer ? <View style={[styles.footer, { borderColor: colors.border }]}>{footer}</View> : null}
      </View>
    </KeyboardAvoidingView>
  )
}
const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { height: '92%', minHeight: 0, borderWidth: 1, borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  title: { flex: 1, minWidth: 0, fontSize: 18, fontWeight: '800' },
  close: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1, minHeight: 0 }, content: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  footer: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  notice: { padding: 12, borderRadius: 8, fontSize: 14 },
  noticeScroll: { maxHeight: '25%', flexGrow: 0, marginHorizontal: 12, marginBottom: 8 }
})
