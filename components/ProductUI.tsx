import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { theme } from '../constants/theme';
import { useRosStore } from '../stores/useRosStore';
import { useSettingsStore } from '../stores/useSettingsStore';

type IconName = keyof typeof Ionicons.glyphMap;
type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const toneColors: Record<Tone, string> = {
  neutral: theme.colors.textSecondary,
  primary: theme.colors.accentPrimary,
  success: theme.colors.statusConnected,
  warning: theme.colors.statusConnecting,
  danger: theme.colors.statusError,
};

export function StatusPill({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: Tone;
  icon?: IconName;
}) {
  const color = toneColors[tone];
  return (
    <View style={[styles.pill, { borderColor: color + '4D', backgroundColor: color + '14' }]}>
      {icon ? <Ionicons name={icon} size={13} color={color} /> : <View style={[styles.pillDot, { backgroundColor: color }]} />}
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function ProductHeader({
  title,
  subtitle,
  showAlerts = true,
  trailing,
}: {
  title: string;
  subtitle?: string;
  showAlerts?: boolean;
  trailing?: React.ReactNode;
}) {
  const router = useRouter();
  const language = useSettingsStore((s) => s.language);
  const status = useRosStore((s) => s.connection.status);
  const url = useRosStore((s) => s.connection.url);
  const demo = url.startsWith('demo://');
  const connected = status === 'connected';
  const statusLabel = demo
    ? (language === 'zh' ? '演示设备' : 'Demo device')
    : status === 'connected'
      ? (language === 'zh' ? '在线' : 'Online')
      : status === 'connecting'
        ? (language === 'zh' ? '连接中' : 'Connecting')
        : status === 'error'
          ? (language === 'zh' ? '连接异常' : 'Connection issue')
          : (language === 'zh' ? '未连接' : 'Offline');

  return (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.headerActions}>
        <StatusPill
          label={statusLabel}
          tone={connected ? (demo ? 'warning' : 'success') : status === 'error' ? 'danger' : 'neutral'}
        />
        {showAlerts ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={language === 'zh' ? '查看告警' : 'View alerts'}
            style={styles.iconButton}
            activeOpacity={0.7}
            onPress={() => router.push('/alerts' as any)}
          >
            <Ionicons name="notifications-outline" size={21} color={theme.colors.textPrimary} />
          </TouchableOpacity>
        ) : null}
        {trailing}
      </View>
    </View>
  );
}

export function SectionHeader({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {actionLabel && onAction ? (
        <TouchableOpacity onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function ProductCard({
  children,
  style,
  emphasized = false,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  emphasized?: boolean;
}) {
  return <View style={[styles.card, emphasized && styles.cardEmphasized, style]}>{children}</View>;
}

export function Metric({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: Tone;
}) {
  const color = tone === 'neutral' ? theme.colors.textSecondary : toneColors[tone];
  return (
    <View style={styles.metric}>
      <Ionicons name={icon} size={18} color={color} />
      <View style={styles.metricCopy}>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={[styles.metricValue, tone !== 'neutral' && { color }]} numberOfLines={1}>{value}</Text>
      </View>
    </View>
  );
}

export function ProductButton({
  label,
  icon,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  compact = false,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
}) {
  const foreground = variant === 'primary'
    ? theme.colors.bgBase
    : variant === 'danger'
      ? theme.colors.statusError
      : variant === 'ghost'
        ? theme.colors.textSecondary
        : theme.colors.textPrimary;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={[
        styles.button,
        compact && styles.buttonCompact,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        variant === 'ghost' && styles.buttonGhost,
        (disabled || loading) && styles.buttonDisabled,
      ]}
      activeOpacity={0.76}
      disabled={disabled || loading}
      onPress={onPress}
    >
      {loading ? <ActivityIndicator size="small" color={foreground} /> : icon ? <Ionicons name={icon} size={18} color={foreground} /> : null}
      <Text style={[styles.buttonText, { color: foreground }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export function InlineNotice({
  title,
  message,
  tone = 'neutral',
  actionLabel,
  onAction,
}: {
  title: string;
  message?: string;
  tone?: Tone;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const color = toneColors[tone];
  const icon: IconName = tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'warning' : tone === 'success' ? 'checkmark-circle' : 'information-circle';
  return (
    <View style={[styles.notice, { borderLeftColor: color }]}>
      <Ionicons name={icon} size={20} color={color} />
      <View style={styles.noticeCopy}>
        <Text style={styles.noticeTitle}>{title}</Text>
        {message ? <Text style={styles.noticeMessage}>{message}</Text> : null}
      </View>
      {actionLabel && onAction ? (
        <TouchableOpacity onPress={onAction} style={styles.noticeAction}>
          <Text style={[styles.noticeActionText, { color }]}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon: IconName;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Ionicons name={icon} size={28} color={theme.colors.textMuted} /></View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
      {actionLabel && onAction ? <ProductButton label={actionLabel} icon="arrow-forward" compact onPress={onAction} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: theme.sizes.appBar,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.xl,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderSubtle,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { ...theme.typography.headingLg, color: theme.colors.textPrimary },
  headerSubtitle: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  iconButton: {
    width: theme.sizes.touchTarget,
    height: theme.sizes.touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bgElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
  },
  pill: {
    minHeight: 30,
    maxWidth: 128,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: theme.radius.pill,
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '600' },
  sectionHeader: {
    minHeight: 30,
    marginTop: theme.spacing.xl,
    marginBottom: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: { ...theme.typography.headingSm, color: theme.colors.textPrimary },
  sectionAction: { ...theme.typography.bodySm, color: theme.colors.accentPrimary, fontWeight: '600' },
  card: {
    backgroundColor: theme.colors.bgElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  cardEmphasized: { backgroundColor: theme.colors.bgSurface, borderColor: theme.colors.borderDefault },
  metric: { flex: 1, minWidth: 124, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  metricCopy: { flex: 1, minWidth: 0 },
  metricLabel: { fontSize: 11, color: theme.colors.textMuted, marginBottom: 2 },
  metricValue: { fontSize: 14, color: theme.colors.textPrimary, fontWeight: '600' },
  button: {
    minHeight: theme.sizes.touchTarget,
    paddingHorizontal: 18,
    borderRadius: theme.radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
  },
  buttonCompact: { alignSelf: 'flex-start', minHeight: 42, paddingHorizontal: 14 },
  buttonPrimary: { backgroundColor: theme.colors.accentPrimary, borderColor: theme.colors.accentPrimary },
  buttonSecondary: { backgroundColor: theme.colors.bgSurface, borderColor: theme.colors.borderDefault },
  buttonDanger: { backgroundColor: theme.colors.statusErrorGlow, borderColor: theme.colors.statusError + '66' },
  buttonGhost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 14, fontWeight: '700' },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderLeftWidth: 3,
    backgroundColor: theme.colors.bgElevated,
  },
  noticeCopy: { flex: 1, minWidth: 0 },
  noticeTitle: { fontSize: 14, color: theme.colors.textPrimary, fontWeight: '600' },
  noticeMessage: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 2 },
  noticeAction: { paddingVertical: 8, paddingLeft: 8 },
  noticeActionText: { fontSize: 13, fontWeight: '700' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 42 },
  emptyIcon: { width: 58, height: 58, borderRadius: 29, backgroundColor: theme.colors.bgSurface, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  emptyTitle: { ...theme.typography.headingMd, color: theme.colors.textPrimary, textAlign: 'center' },
  emptyMessage: { ...theme.typography.body, color: theme.colors.textMuted, textAlign: 'center', maxWidth: 360, marginTop: 6, marginBottom: 18 },
});
