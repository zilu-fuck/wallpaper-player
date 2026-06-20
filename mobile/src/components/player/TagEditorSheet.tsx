import { Plus, Tag, X } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors } from '../../theme'
import type { VideoItem } from '../../types'
import { BOTTOM_SAFE_OFFSET } from '../../screens/player/playerLayout'
import { getVideoTitle, uniqueText } from '../../screens/player/playerUtils'

type Props = {
  visible: boolean
  video: VideoItem
  availableCustomTags: string[]
  saving?: boolean
  onClose: () => void
  onSave: (tags: string[]) => void
}

export function TagEditorSheet({
  visible,
  video,
  availableCustomTags,
  saving = false,
  onClose,
  onSave
}: Props) {
  const systemTags = useMemo(() => {
    if (video.systemTags?.length) return uniqueText(video.systemTags)
    const customTagSet = new Set(video.customTags || [])
    return uniqueText(video.tags || []).filter(tag => !customTagSet.has(tag))
  }, [video])
  const initialCustomTags = useMemo(() => uniqueText(video.customTags || []), [video])
  const [selectedTags, setSelectedTags] = useState<string[]>(initialCustomTags)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!visible) return
    setSelectedTags(initialCustomTags)
    setDraft('')
  }, [initialCustomTags, visible])

  const allCustomOptions = useMemo(() => uniqueText([
    ...selectedTags,
    ...availableCustomTags
  ]), [availableCustomTags, selectedTags])

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 16 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 48) onClose()
    }
  }), [onClose])

  if (!visible) return null

  const toggleTag = (tag: string) => {
    setSelectedTags(current => current.includes(tag)
      ? current.filter(item => item !== tag)
      : [...current, tag])
  }

  const addDraftTag = () => {
    const next = draft.trim()
    if (!next) return
    setSelectedTags(current => current.includes(next) ? current : [...current, next])
    setDraft('')
  }

  return (
    <View style={styles.backdrop}>
      <Pressable style={styles.backdropPress} onPress={onClose} />
      <View style={styles.sheet} {...panResponder.panHandlers}>
        <View style={styles.handleWrap}>
          <View style={styles.handle} />
        </View>

        <View style={styles.topCard}>
          <View style={styles.topIcon}>
            <Tag color="#101114" size={20} />
          </View>
          <View style={styles.topText}>
            <Text style={styles.topTitle}>管理视频标签</Text>
            <Text style={styles.topSubtitle} numberOfLines={1}>{getVideoTitle(video)}</Text>
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <X color="#2d3036" size={20} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>原本标签</Text>
            <Text style={styles.sectionMeta}>{systemTags.length || 0} 个</Text>
          </View>
          <View style={styles.chipWrap}>
            {systemTags.length > 0 ? systemTags.map(tag => (
              <View key={tag} style={[styles.chip, styles.systemChip]}>
                <Text style={styles.systemChipText}>{tag}</Text>
              </View>
            )) : (
              <Text style={styles.emptyText}>没有识别到原始标签</Text>
            )}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>自定义标签</Text>
            <Text style={styles.sectionMeta}>可多选</Text>
          </View>

          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={addDraftTag}
              placeholder="输入新标签"
              placeholderTextColor="rgba(16,17,20,0.42)"
              style={styles.input}
              returnKeyType="done"
            />
            <Pressable style={styles.addButton} onPress={addDraftTag}>
              <Plus color="#101114" size={20} />
              <Text style={styles.addButtonText}>新建</Text>
            </Pressable>
          </View>

          <View style={styles.optionList}>
            {allCustomOptions.length > 0 ? allCustomOptions.map((tag, index) => {
              const selected = selectedTags.includes(tag)
              return (
                <Pressable key={tag} style={styles.optionItem} onPress={() => toggleTag(tag)}>
                  <View style={styles.optionTextBlock}>
                    <Text style={styles.optionTitle}>{tag}</Text>
                    <Text style={styles.optionSubtitle}>{selected ? '已添加到当前视频' : `自定义标签 ${index + 1}`}</Text>
                  </View>
                  <View style={[styles.radio, selected && styles.radioSelected]}>
                    {selected ? <View style={styles.radioDot} /> : null}
                  </View>
                </Pressable>
              )
            }) : (
              <Text style={styles.emptyText}>还没有自定义标签，输入后点新建</Text>
            )}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable style={styles.doneButton} disabled={saving} onPress={() => onSave(selectedTags)}>
            <Text style={styles.doneButtonText}>{saving ? '保存中...' : '完成'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.32)',
    justifyContent: 'flex-end'
  },
  backdropPress: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  sheet: {
    maxHeight: '78%',
    paddingBottom: BOTTOM_SAFE_OFFSET,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    backgroundColor: '#f8f9fb',
    overflow: 'hidden'
  },
  handleWrap: {
    height: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(16,17,20,0.12)'
  },
  topCard: {
    marginHorizontal: 16,
    marginBottom: 14,
    minHeight: 72,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2
  },
  topIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center'
  },
  topText: {
    flex: 1,
    minWidth: 0
  },
  topTitle: {
    color: '#101114',
    fontSize: 16,
    fontWeight: '800'
  },
  topSubtitle: {
    marginTop: 4,
    color: 'rgba(16,17,20,0.56)',
    fontSize: 12
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center'
  },
  content: {
    paddingHorizontal: 18,
    paddingBottom: 10
  },
  sectionHeader: {
    marginTop: 4,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  sectionTitle: {
    color: '#101114',
    fontSize: 16,
    fontWeight: '900'
  },
  sectionMeta: {
    color: 'rgba(16,17,20,0.5)',
    fontSize: 13,
    fontWeight: '700'
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 18
  },
  chip: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center'
  },
  systemChip: {
    backgroundColor: '#eceff3'
  },
  systemChipText: {
    color: 'rgba(16,17,20,0.74)',
    fontSize: 13,
    fontWeight: '800'
  },
  emptyText: {
    color: 'rgba(16,17,20,0.48)',
    fontSize: 13,
    lineHeight: 20
  },
  inputRow: {
    marginBottom: 14,
    flexDirection: 'row',
    gap: 10
  },
  input: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    color: '#101114',
    fontSize: 14,
    fontWeight: '700'
  },
  addButton: {
    minWidth: 88,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4
  },
  addButtonText: {
    color: '#101114',
    fontSize: 14,
    fontWeight: '800'
  },
  optionList: {
    borderRadius: 14,
    backgroundColor: '#ffffff',
    overflow: 'hidden'
  },
  optionItem: {
    minHeight: 70,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(16,17,20,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  optionTextBlock: {
    flex: 1,
    minWidth: 0
  },
  optionTitle: {
    color: '#101114',
    fontSize: 16,
    fontWeight: '800'
  },
  optionSubtitle: {
    marginTop: 6,
    color: 'rgba(16,17,20,0.54)',
    fontSize: 12,
    fontWeight: '700'
  },
  radio: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 2,
    borderColor: 'rgba(16,17,20,0.22)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  radioSelected: {
    borderColor: colors.accent
  },
  radioDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.accent
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(16,17,20,0.12)',
    backgroundColor: '#ffffff',
    paddingHorizontal: 18,
    paddingTop: 12
  },
  doneButton: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  doneButtonText: {
    color: '#101114',
    fontSize: 18,
    fontWeight: '900'
  }
})
