/** The desktop app's palette (apps/web/src/ui/tokens.css), so both read as one product. */
export const colors = {
  appBg: '#101010',
  panel: '#161616',
  card: '#1a1a1a',
  raised: '#1f1f1f',
  hover: '#262626',
  active: '#2c2c2c',
  border: '#2c2c2c',
  borderSubtle: '#242424',
  code: '#121212',
  terminal: '#0f0f0f',
  text: '#ececec',
  textSecondary: '#d4d4d4',
  muted: '#8a8a8a',
  faint: '#6a6a6a',
  accent: '#e9a23b',
  accentSoft: '#3a2f1c',
  success: '#7cc48a',
  successSoft: '#14261a',
  danger: '#e0716c',
  dangerSoft: '#2a1717',
  info: '#8fb2f5',
  infoSoft: '#1b2a44',
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
