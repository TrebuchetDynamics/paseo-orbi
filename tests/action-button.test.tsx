import './helpers/host';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { ActionButton, type ActionVariant } from '../client/action-button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Two complete host palettes: the component must follow the host theme, not
// hard-code a dark or light ink/fill.
const palettes = {
  dark: { surface0: '#0b0b0c', surface1: '#17181a', surface2: '#222428', border: '#34363b', foreground: '#f2f2f2', foregroundMuted: '#a0a0a0', accent: '#4f8cff', accentForeground: '#04121f', statusSuccess: '#31c48d', statusWarning: '#f5a524', statusDanger: '#f2555a' },
  light: { surface0: '#ffffff', surface1: '#f4f5f7', surface2: '#e6e8ec', border: '#c9ccd2', foreground: '#111318', foregroundMuted: '#585c66', accent: '#1d4ed8', accentForeground: '#ffffff', statusSuccess: '#157f4b', statusWarning: '#9a6100', statusDanger: '#b3261e' },
} as const;
type Appearance = keyof typeof palettes;
const theme = (appearance: Appearance) => ({ colors: palettes[appearance] }) as PluginHostProps['theme'];

let renderer: ReactTestRenderer | undefined;
async function render(props: Partial<React.ComponentProps<typeof ActionButton>> = {}) {
  await act(async () => {
    renderer = create(<ActionButton theme={theme('dark')} label="Refresh issues" accessibilityName="Refresh issues" onPress={() => {}} {...props} />);
  });
  return renderer!;
}
const button = (tree: ReactTestRenderer, name: string) => tree.root.findByProps({ accessibilityLabel: name });
const style = (tree: ReactTestRenderer, name: string, pressed = false): Record<string, unknown> => button(tree, name).props.style({ pressed });

describe('ActionButton', () => {
  it('renders one visible, labelled 44x44 button with a separate accessible name', async () => {
    const tree = await render({ label: 'Inspect issue', accessibilityName: 'Inspect issue 42' });
    const control = button(tree, 'Inspect issue 42');
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.disabled).toBe(false);
    expect(control.props.accessibilityState).toEqual({ disabled: false, busy: false });
    expect(control.findAllByType('Text' as any).map(node => node.children.join(''))).toEqual(['Inspect issue']);
    // The accessible name is announced once: the wrapper carries no role and no
    // duplicate accessibilityLabel.
    expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Inspect issue 42')).toHaveLength(1);
    expect(tree.root.findAll(node => node.props.accessibilityRole === 'button')).toHaveLength(1);
    expect(style(tree, 'Inspect issue 42')).toMatchObject({ minHeight: 44, minWidth: 44 });
  });

  it('uses a filled primary, outlined secondary and danger styling from the current theme', async () => {
    for (const appearance of ['dark', 'light'] as const) {
      const colors = palettes[appearance];
      for (const variant of ['primary', 'secondary', 'danger'] as ActionVariant[]) {
        const tree = await render({ theme: theme(appearance), variant, label: 'Start slot 1', accessibilityName: 'Start slot 1' });
        const control = button(tree, 'Start slot 1');
        const ink = control.findByType('Text' as any).props.style.color;
        const base = style(tree, 'Start slot 1');
        if (variant === 'primary') {
          expect(base).toMatchObject({ backgroundColor: colors.accent, borderColor: colors.accent });
          expect(ink).toBe(colors.accentForeground);
        } else if (variant === 'danger') {
          expect(base).toMatchObject({ backgroundColor: colors.surface1, borderColor: colors.statusDanger });
          expect(ink).toBe(colors.statusDanger);
        } else {
          expect(base).toMatchObject({ backgroundColor: colors.surface1, borderColor: colors.border });
          expect(ink).toBe(colors.foreground);
        }
      }
    }
  });

  it('gives pressed and keyboard-focus feedback', async () => {
    const tree = await render();
    expect(style(tree, 'Refresh issues', true).opacity).toBeLessThan(1);
    expect(style(tree, 'Refresh issues', false).opacity).toBe(1);
    const control = button(tree, 'Refresh issues');
    await act(async () => control.props.onFocus());
    expect(style(tree, 'Refresh issues', false)).toMatchObject({ borderColor: palettes.dark.accent, borderWidth: 2 });
    await act(async () => control.props.onBlur());
    expect(style(tree, 'Refresh issues', false).borderColor).toBe(palettes.dark.border);
    // A filled primary also changes on focus: its base outline is the accent
    // fill itself, so the ring switches to the contrast ink.
    await act(async () => tree.update(<ActionButton theme={theme('dark')} variant="primary" label="Start slot 1" accessibilityName="Start slot 1" onPress={() => {}} />));
    await act(async () => button(tree, 'Start slot 1').props.onFocus());
    expect(style(tree, 'Start slot 1', false)).toMatchObject({ borderColor: palettes.dark.accentForeground, borderWidth: 2 });
  });

  it('ignores presses while disabled or busy so one action cannot submit twice', async () => {
    const submit = vi.fn();
    const tree = await render({ label: 'Confirm start', accessibilityName: 'Confirm start slot 1', onPress: submit });
    await act(async () => button(tree, 'Confirm start slot 1').props.onPress());
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => tree.update(<ActionButton theme={theme('dark')} label="Confirm start" accessibilityName="Confirm start slot 1"
      disabled busy onPress={submit} />));
    const busy = button(tree, 'Confirm start slot 1');
    expect(busy.props.disabled).toBe(true);
    expect(busy.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(style(tree, 'Confirm start slot 1').opacity).toBeLessThan(0.7);
    await act(async () => busy.props.onPress());
    await act(async () => button(tree, 'Confirm start slot 1').props.onPress());
    expect(submit).toHaveBeenCalledTimes(1);
    // The visible label stays readable while busy; the caller supplies the
    // in-flight wording, the component never replaces or hides it.
    expect(button(tree, 'Confirm start slot 1').findByType('Text' as any).children.join('')).toBe('Confirm start');
  });

  it('keeps selected and expanded state visible and announced', async () => {
    const tree = await render({ label: 'Open issues', accessibilityName: 'Browse open issues', selected: true, expanded: false });
    const selected = button(tree, 'Browse open issues');
    expect(selected.props.accessibilityState).toEqual({ selected: true, expanded: false, disabled: false, busy: false });
    expect(style(tree, 'Browse open issues')).toMatchObject({ backgroundColor: palettes.dark.surface2, borderColor: palettes.dark.accent });
    await act(async () => tree.update(<ActionButton theme={theme('dark')} label="Open issues" accessibilityName="Browse open issues" selected={false} expanded onPress={() => {}} />));
    const rest = button(tree, 'Browse open issues');
    expect(rest.props.accessibilityState).toEqual({ selected: false, expanded: true, disabled: false, busy: false });
    expect(style(tree, 'Browse open issues')).toMatchObject({ backgroundColor: palettes.dark.surface1, borderColor: palettes.dark.border });
  });

  it('wraps a long label inside the available width instead of clipping it', async () => {
    const long = 'Confirm restart of this repository runner slot on the selected host';
    const tree = await render({ label: long, accessibilityName: 'Confirm restart slot 1' });
    const control = button(tree, 'Confirm restart slot 1');
    expect(control.findAllByType('Text' as any)[0].children.join('')).toBe(long);
    expect(control.findAllByType('Text' as any)[0].props.numberOfLines).toBeUndefined();
    expect(control.findAllByType('Text' as any)[0].props.style).toMatchObject({ flexShrink: 1 });
    expect(style(tree, 'Confirm restart slot 1')).toMatchObject({ maxWidth: '100%' });
  });
});
