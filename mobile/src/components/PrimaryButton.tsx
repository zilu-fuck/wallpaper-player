import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme-context'

type Props = {
  label: string
  icon?: ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  loading?: boolean
  onPress: () => void
}

export function PrimaryButton({ label, icon, variant = 'primary', disabled, loading, onPress }: Props) {
  const { colors } = useTheme()
  const styles = createStyles(colors)

  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        (disabled || loading) && styles.disabled,
        pressed && !disabled ? styles.pressed : null
      ]}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }}
      onPress={onPress}
    >
      {loading ? <ActivityIndicator color={variant === 'secondary' ? colors.text : colors.onAccent} size="small" /> : null}
      {!loading && icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text style={[styles.label, variant === 'secondary' && styles.secondaryLabel, variant === 'danger' && styles.dangerLabel]}>{label}</Text>
    </Pressable>
  )
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) => StyleSheet.create({
  button: {
    minHeight: 50,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  primary: {
    backgroundColor: colors.accentStrong,
    shadowColor: '#000000',
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3
  },
  secondary: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border
  },
  danger: {
    backgroundColor: 'transparent',
    borderColor: colors.danger
  },
  disabled: {
    opacity: 0.5
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.985 }]
  },
  icon: {
    flexShrink: 0,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  label: {
    flexShrink: 1,
    textAlign: 'center',
    color: colors.onAccent,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2
  },
  secondaryLabel: {
    color: colors.text
  },
  dangerLabel: {
    color: colors.danger
  }
})
