import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState, ProductCard, StatusPill } from '../components/ProductUI';
import { theme } from '../constants/theme';
import { useProductCopy } from '../lib/product-copy';
import { LOCALIZATION_STATE, MISSION_EVENT } from '../lib/mission/types';
import { useMissionStore } from '../stores/useMissionStore';
import { useRosStore } from '../stores/useRosStore';

interface AlertItem {
  id: string;
  title: string;
  message: string;
  tone: 'warning' | 'danger';
  icon: keyof typeof Ionicons.glyphMap;
}

export default function AlertsScreen() {
  const router = useRouter();
  const { pc, language } = useProductCopy();
  const status = useRosStore((s) => s.connection.status);
  const error = useRosStore((s) => s.connection.error);
  const missionError = useMissionStore((s) => s.lastError);
  const robot = useMissionStore((s) => s.robotStrip);
  const events = useMissionStore((s) => s.events);

  const alerts: AlertItem[] = [];
  if (status === 'error' || error) {
    alerts.push({
      id: 'connection',
      title: language === 'zh' ? '连接异常' : 'Connection issue',
      message: error || (language === 'zh' ? '无法连接机器人，请检查网络和网关。' : 'Unable to reach the robot. Check the network and gateway.'),
      tone: 'danger',
      icon: 'cloud-offline-outline',
    });
  }
  if (missionError) {
    alerts.push({ id: 'mission', title: language === 'zh' ? '任务执行异常' : 'Mission issue', message: missionError, tone: 'danger', icon: 'clipboard-outline' });
  }
  if (robot?.estop_latched) {
    alerts.push({ id: 'estop', title: language === 'zh' ? '急停已锁止' : 'Emergency stop latched', message: language === 'zh' ? '确认现场安全后，从控制页面执行双重安全复位。' : 'Confirm the area is safe, then use the two-step reset on the Control screen.', tone: 'danger', icon: 'stop-circle-outline' });
  }
  if (robot?.localization_state === LOCALIZATION_STATE.LOST) {
    alerts.push({ id: 'localization', title: language === 'zh' ? '定位丢失' : 'Localization lost', message: language === 'zh' ? '机器人无法确认当前位置，请停止自主任务并重新定位。' : 'The robot cannot confirm its position. Stop autonomous work and relocalize.', tone: 'warning', icon: 'navigate-circle-outline' });
  }
  events
    .filter((event) => event.event === MISSION_EVENT.FAILED || event.event === MISSION_EVENT.INTERRUPTED)
    .slice(0, 5)
    .forEach((event) => alerts.push({
      id: `event-${event.mission_id}-${event.sequence}`,
      title: event.event === MISSION_EVENT.FAILED ? (language === 'zh' ? '巡检任务失败' : 'Mission failed') : (language === 'zh' ? '巡检任务中断' : 'Mission interrupted'),
      message: event.reason_text || event.mission_id,
      tone: event.event === MISSION_EVENT.FAILED ? 'danger' : 'warning',
      icon: 'alert-circle-outline',
    }));

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => router.back()} accessibilityLabel={pc('common.back')}>
          <Ionicons name="chevron-back" size={23} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{pc('alerts.title')}</Text>
          <Text style={styles.subtitle}>{pc('alerts.subtitle')}</Text>
        </View>
        <StatusPill label={`${alerts.length}`} tone={alerts.length > 0 ? 'danger' : 'success'} icon={alerts.length > 0 ? 'warning' : 'checkmark'} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {status === 'disconnected' ? (
          <ProductCard style={styles.offline}>
            <Ionicons name="cloud-offline-outline" size={22} color={theme.colors.textMuted} />
            <View style={styles.offlineCopy}>
              <Text style={styles.offlineTitle}>{pc('alerts.offline')}</Text>
              <Text style={styles.offlineText}>{pc('alerts.offlineHint')}</Text>
            </View>
          </ProductCard>
        ) : null}
        {alerts.length === 0 ? (
          <EmptyState icon="shield-checkmark-outline" title={pc('alerts.none')} message={pc('alerts.noneHint')} />
        ) : alerts.map((item) => (
          <ProductCard key={item.id} style={styles.alertCard}>
            <View style={[styles.alertIcon, { backgroundColor: (item.tone === 'danger' ? theme.colors.statusError : theme.colors.statusConnecting) + '18' }]}>
              <Ionicons name={item.icon} size={22} color={item.tone === 'danger' ? theme.colors.statusError : theme.colors.statusConnecting} />
            </View>
            <View style={styles.alertCopy}>
              <View style={styles.alertTitleRow}>
                <Text style={styles.alertTitle}>{item.title}</Text>
                <StatusPill label={item.tone === 'danger' ? (language === 'zh' ? '严重' : 'Critical') : (language === 'zh' ? '警告' : 'Warning')} tone={item.tone} />
              </View>
              <Text style={styles.alertMessage}>{item.message}</Text>
            </View>
          </ProductCard>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bgBase },
  header: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.borderSubtle },
  back: { width: 46, height: 46, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1 },
  title: { ...theme.typography.headingLg, color: theme.colors.textPrimary },
  subtitle: { ...theme.typography.bodySm, color: theme.colors.textMuted },
  content: { width: '100%', maxWidth: theme.sizes.contentMax, alignSelf: 'center', padding: 18, gap: 10 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  offlineCopy: { flex: 1 },
  offlineTitle: { fontSize: 14, fontWeight: '600', color: theme.colors.textPrimary },
  offlineText: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 2 },
  alertCard: { flexDirection: 'row', gap: 13 },
  alertIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  alertCopy: { flex: 1, minWidth: 0 },
  alertTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: theme.colors.textPrimary },
  alertMessage: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 7 },
});
