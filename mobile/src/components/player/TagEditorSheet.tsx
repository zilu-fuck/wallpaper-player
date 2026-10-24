import { Plus } from 'lucide-react-native'
import { useMemo } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useTheme } from '../../theme-context'
import type { ThemeColors } from '../../theme'
import type { VideoItem } from '../../types'
import type { TagEditorDraft } from '../../hooks/useTagEditorDraft'
import { getVideoTitle, uniqueText } from '../../screens/player/playerUtils'
import { PlayerSheetFrame } from './PlayerSheetFrame'

type Props = {
  visible: boolean; video: VideoItem; editor: TagEditorDraft; availableCustomTags: string[]
  saving?: boolean; loading?: boolean; error?: string; editKey?: number; notice?: string
  onReload?: () => void; onClose: () => void; onSave: (tags: string[]) => void
}
export function TagEditorSheet({ visible, video, editor, availableCustomTags, saving = false, loading = false,
  error = '', notice, onReload, onClose, onSave }: Props) {
  const { colors } = useTheme(), styles = createStyles(colors)
  const systemTags = useMemo(() => video.systemTags ? uniqueText(video.systemTags)
    : uniqueText(video.tags || []).filter(tag => !(video.customTags || []).includes(tag)), [video])
  const options = useMemo(() => uniqueText([...editor.tags, ...availableCustomTags]), [editor.tags, availableCustomTags])
  if (!visible) return null
  const disabled = loading || saving
  return (
    <PlayerSheetFrame title="管理标签" onClose={onClose} notice={notice} footer={
      <Pressable accessibilityRole="button" accessibilityLabel="保存视频标签" accessibilityState={{ disabled, busy: disabled }}
        style={styles.done} disabled={disabled} onPress={() => onSave(editor.tags)}>
        <Text style={styles.doneText}>{saving ? '保存中…' : loading ? '读取中…' : '完成'}</Text>
      </Pressable>
    }>
      <Text style={styles.name}>{getVideoTitle(video)}</Text>
      {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      {error && onReload ? <Pressable accessibilityRole="button" accessibilityState={{ disabled }} style={styles.action}
        disabled={disabled} onPress={onReload}><Text style={styles.text}>重新载入最新标签（替换草稿）</Text></Pressable> : null}
      <Text accessibilityRole="header" style={styles.heading}>原本标签</Text>
      <View style={styles.wrap}>{systemTags.length ? systemTags.map(tag => <View key={tag} style={styles.chip}><Text style={styles.text}>{tag}</Text></View>)
        : <Text style={styles.muted}>没有识别到原始标签</Text>}</View>
      <Text accessibilityRole="header" style={styles.heading}>自定义标签</Text>
      <View style={styles.inputRow}>
        <TextInput accessibilityLabel="新标签名称" value={editor.text} editable={!disabled} onChangeText={editor.setText}
          onSubmitEditing={editor.add} placeholder="输入新标签" placeholderTextColor={colors.subtle} style={styles.input} returnKeyType="done" />
        <Pressable accessibilityRole="button" accessibilityLabel="新建标签" accessibilityState={{ disabled }} style={styles.add}
          disabled={disabled} onPress={editor.add}><Plus color={colors.text} size={20} /><Text style={styles.text}>新建</Text></Pressable>
      </View>
      {options.length ? options.map(tag => {
        const selected = editor.tags.includes(tag)
        return <Pressable key={tag} accessibilityRole="checkbox" accessibilityLabel={'自定义标签：' + tag}
          accessibilityState={{ checked: selected, disabled }} disabled={disabled} style={styles.option} onPress={() => editor.toggle(tag)}>
          <View style={styles.optionText}><Text style={styles.text}>{tag}</Text><Text style={styles.muted}>{selected ? '已添加到当前视频' : '尚未添加'}</Text></View>
          <Text importantForAccessibility="no" style={styles.mark}>{selected ? '✓' : '○'}</Text>
        </Pressable>
      }) : <Text style={styles.muted}>还没有自定义标签，输入后点新建</Text>}
    </PlayerSheetFrame>
  )
}
const createStyles = (colors: ThemeColors) => StyleSheet.create({
  name: { color: colors.muted, fontSize: 14 }, heading: { color: colors.text, fontSize: 16, fontWeight: '800' },
  text: { color: colors.text, fontSize: 14, flexShrink: 1 }, muted: { color: colors.muted, fontSize: 13 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, chip: { maxWidth: '100%', padding: 10, borderRadius: 12, backgroundColor: colors.surfaceElevated },
  inputRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  input: { flexGrow: 1, flexBasis: 160, minWidth: 0, minHeight: 48, padding: 12, borderRadius: 8, color: colors.text, backgroundColor: colors.surfaceElevated, fontSize: 16 },
  add: { minHeight: 48, padding: 12, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated, borderRadius: 8 },
  option: { minHeight: 48, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 8, backgroundColor: colors.surfaceElevated },
  optionText: { flex: 1, minWidth: 0, gap: 6 }, mark: { color: colors.text, fontSize: 24 },
  done: { minHeight: 48, padding: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.accentStrong },
  doneText: { color: colors.onAccent, fontSize: 18, fontWeight: '800' },
  error: { color: colors.text, borderLeftWidth: 3, borderLeftColor: colors.danger, padding: 12, backgroundColor: colors.surfaceElevated, fontSize: 14 },
  action: { minHeight: 48, padding: 12, borderRadius: 8, backgroundColor: colors.surfaceElevated }
})
