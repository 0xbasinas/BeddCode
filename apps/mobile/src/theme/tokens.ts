/** The desktop app's palette (apps/web/src/ui/tokens.css), so both read as one product. */
export const colors = {
  appBg: '#101010',
  panel: '#161616',
  card: '#1a1a1a',
  raised: '#1f1f1f',
  hover: '#262626',
  active: '#2c2c2c',
  border: '#2c2c2c',
  borderStrong: '#4a4a4a',
  borderSubtle: '#242424',
  code: '#121212',
  terminal: '#0f0f0f',
  /** Solid app background used by full-screen forms (previously hardcoded per screen). */
  screenBg: '#121212',
  text: '#ececec',
  textSecondary: '#d4d4d4',
  /** Dimmer than `muted`; used for off-state labels and gutter icons. */
  textMuted: '#4a4a4a',
  muted: '#8a8a8a',
  faint: '#6a6a6a',
  accent: '#e9a23b',
  accentSoft: '#3a2f1c',
  success: '#7cc48a',
  successSoft: '#14261a',
  /** The brighter success tint screens switch a badge or panel to while connected. */
  successStrong: '#1c3322',
  danger: '#e0716c',
  dangerSoft: '#2a1717',
  /** Danger-tinted panel border (destructive cards and banners). */
  dangerBorder: '#4a2523',
  info: '#8fb2f5',
  infoSoft: '#1b2a44',
  /** Panel and border tints for info-highlighted states. */
  infoActive: '#1e3a6a',
  infoPanel: '#16223a',
  infoHint: '#12203a',
  infoBorder: '#2f4f8a',
  /** Pin color for merged pull requests. */
  purple: '#bb9af7',
  /** The dim scrim behind full-screen image previews. */
  overlay: 'rgba(0,0,0,0.9)',
  shadow: '#000000',
  /** The light primary button of the desktop app. */
  primary: '#d8d8d8',
  onPrimary: '#161616',
} as const

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
} as const

export const radius = { control: 8, panel: 10, sheet: 16, pill: 999 } as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
