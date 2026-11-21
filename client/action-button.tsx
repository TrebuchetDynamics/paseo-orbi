import { useState, type ReactNode } from 'react';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Pressable, Text, type ViewStyle } from 'react-native';

// One theme-aware action for Work and Services. It looks like a control before
// it is tapped: a visible label, a 44x44 minimum target, a filled primary, a
// soft-filled/outlined secondary and a danger outline used only for an
// operator-granted destructive action. State (selected, expanded, disabled,
// busy) is announced and drawn; a disabled or busy button ignores the press so
// one service action can never be submitted twice.

export type ActionVariant = 'primary' | 'secondary' | 'danger';

const MIN_TARGET = 44;

export function ActionButton({
  label, children, accessibilityName, accessibilityHint, onPress, theme, variant = 'secondary',
  disabled = false, busy = false, selected, expanded, testID, style,
}: {
  // The short visible word; the accessible name keeps the row's context
  // ("Inspect issue 42") so screen-reader users hear one unambiguous action.
  // Rich controls (a family row's name, facts and chevron) pass children
  // instead; the visible content still names the action.
  label?: string;
  children?: ReactNode;
  accessibilityName: string;
  accessibilityHint?: string;
  onPress: () => void;
  theme: PluginHostProps['theme'];
  variant?: ActionVariant;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
  expanded?: boolean;
  testID?: string;
  // Only a plain override is merged: callers never replace the base target,
  // pressed, focus or disabled feedback.
  style?: ViewStyle;
}) {
  const [focused, setFocused] = useState(false);
  const inactive = disabled || busy;
  const colors = theme.colors;
  const tone = {
    primary: { backgroundColor: colors.accent, borderColor: colors.accent, ink: colors.accentForeground },
    secondary: { backgroundColor: selected ? colors.surface2 : colors.surface1, borderColor: selected ? colors.accent : colors.border, ink: colors.foreground },
    danger: { backgroundColor: colors.surface1, borderColor: colors.statusDanger, ink: colors.statusDanger },
  }[variant];
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityName}
    accessibilityHint={accessibilityHint}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), ...(expanded === undefined ? {} : { expanded }), disabled: inactive, busy }}
    disabled={inactive}
    testID={testID}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    onPress={() => { if (!inactive) onPress(); }}
    style={({ pressed }) => ({
      minHeight: MIN_TARGET, minWidth: MIN_TARGET, maxWidth: '100%',
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 12, borderRadius: 8, borderWidth: 2,
      alignSelf: 'flex-start',
      backgroundColor: tone.backgroundColor,
      // A keyboard/app focus ring is always a visible change: the accent ring on
      // outlined buttons and the contrast ink on a filled primary.
      borderColor: focused ? (variant === 'primary' ? colors.accentForeground : colors.accent) : tone.borderColor,
      // Disabled and loading buttons stay visibly labelled but cannot be
      // mistaken for one that still accepts a press.
      opacity: busy ? 0.55 : disabled ? 0.45 : pressed ? 0.7 : 1,
      ...style,
    })}
  >
    {children ?? <Text style={{ color: tone.ink, fontWeight: variant === 'secondary' && !selected ? '400' : '600', flexShrink: 1 }}>{label}</Text>}
  </Pressable>;
}
