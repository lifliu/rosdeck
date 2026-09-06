/**
 * OmniDeck product design tokens.
 *
 * The interface is deliberately dark for field operation, but it avoids pure
 * black, neon glows and hairline controls.  Existing widgets still consume the
 * legacy token names below, so the visual refresh can be rolled out without
 * touching any ROS or control code.
 */

export const theme = {
  colors: {
    bgBase: '#071015',
    bgElevated: '#0D181E',
    bgSurface: '#132129',
    bgInset: '#091318',
    borderSubtle: '#1A2B33',
    borderDefault: '#29404A',
    borderFocus: '#66B8C4',
    accentPrimary: '#66B8C4',
    accentPrimaryPressed: '#4F98A3',
    accentPrimaryMuted: '#66B8C41F',
    statusConnected: '#65C49B',
    statusConnectedGlow: '#65C49B26',
    statusConnecting: '#F2B35E',
    statusConnectingGlow: '#F2B35E26',
    statusError: '#F06A6A',
    statusErrorGlow: '#F06A6A26',
    statusDisconnected: '#758690',
    statusDisconnectedGlow: '#75869026',
    textPrimary: '#F3F7F8',
    textSecondary: '#AFBEC4',
    textMuted: '#71838C',
    textValue: '#DFE8EB',
    overlayLight: '#FFFFFF08',
    overlayMedium: '#FFFFFF12',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 32,
    '4xl': 40,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 14,
    xl: 18,
    pill: 999,
    full: 9999,
  },
  typography: {
    display: { fontSize: 28, fontWeight: '700' as const, lineHeight: 35 },
    headingLg: { fontSize: 22, fontWeight: '700' as const, lineHeight: 29 },
    headingMd: { fontSize: 18, fontWeight: '600' as const, lineHeight: 24 },
    headingSm: { fontSize: 15, fontWeight: '600' as const, lineHeight: 21 },
    body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 22 },
    bodySm: { fontSize: 13, fontWeight: '400' as const, lineHeight: 19 },
    label: {
      fontSize: 12,
      fontWeight: '500' as const,
      lineHeight: 16.2,
      letterSpacing: 0.8,
      textTransform: 'uppercase' as const,
    },
    labelSm: { fontSize: 11, fontWeight: '500' as const, lineHeight: 14.3 },
    monoLg: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22.4, fontFamily: 'SpaceMono' },
    monoMd: { fontSize: 14, fontWeight: '400' as const, lineHeight: 19.6, fontFamily: 'SpaceMono' },
    monoSm: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16.2, fontFamily: 'SpaceMono' },
    monoXs: { fontSize: 10, fontWeight: '400' as const, lineHeight: 13, fontFamily: 'SpaceMono' },
  },
  sizes: {
    touchTarget: 48,
    appBar: 64,
    bottomBar: 72,
    contentMax: 840,
  },
  joystick: {
    phone: { radius: 75, knobSize: 56 },
    tablet: { radius: 100, knobSize: 72 },
    springConfig: { damping: 15, stiffness: 180, mass: 0.8 },
  },
  statusColors: {
    disconnected: '#6B7280',
    connecting: '#FBBF24',
    connected: '#34D399',
    error: '#EF4444',
  } as Record<string, string>,
} as const;
