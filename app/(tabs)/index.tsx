import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  InlineNotice,
  Metric,
  ProductButton,
  ProductCard,
  ProductHeader,
  SectionHeader,
  StatusPill,
} from '../../components/ProductUI';
import { theme } from '../../constants/theme';
import { useOrientation } from '../../hooks/useOrientation';
import { useProductCopy } from '../../lib/product-copy';
import { resolveHomeModeKey } from '../../lib/runtime-presentation';
import {
  cancelMission,
  pauseMission,
  resumeMission,
} from '../../lib/mission/api';
import { LOCALIZATION_STATE, MISSION_STATE } from '../../lib/mission/types';
import { useControlAuthorityStore } from '../../stores/useControlAuthorityStore';
import { useAutonomyRuntimeStore } from '../../stores/useAutonomyRuntimeStore';
import { useLayoutStore } from '../../stores/useLayoutStore';
import { useMissionStore } from '../../stores/useMissionStore';
import { useRosStore } from '../../stores/useRosStore';

function robotName(url: string, demo: boolean): string {
  if (demo) return 'Omni Scout · Demo';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url.replace(/^wss?:\/\//, '').split('/')[0] || 'Omni Robot';
  }
}

function formatBattery(value: number | undefined, demo: boolean): string {
  if (demo) return '86%';
  if (value === undefined || !Number.isFinite(value)) return '—';
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
}

function missionStateText(state: number, language: 'en' | 'zh'): string {
  const values: Record<number, [string, string]> = {
    [MISSION_STATE.PENDING]: ['等待执行', 'Pending'],
    [MISSION_STATE.EXECUTING]: ['执行中', 'In progress'],
    [MISSION_STATE.PAUSED]: ['已暂停', 'Paused'],
    [MISSION_STATE.SUCCEEDED]: ['已完成', 'Completed'],
    [MISSION_STATE.CANCELED]: ['已取消', 'Canceled'],
    [MISSION_STATE.FAILED]: ['执行失败', 'Failed'],
    [MISSION_STATE.INTERRUPTED]: ['已中断', 'Interrupted'],
  };
  const pair = values[state] ?? ['暂无任务', 'No mission'];
  return language === 'zh' ? pair[0] : pair[1];
}

export default function HomeScreen() {
  const router = useRouter();
  const { pc, language } = useProductCopy();
  const { isLandscape } = useOrientation();
  const connection = useRosStore((s) => s.connection);
  const transport = useRosStore((s) => s.transport);
  const mission = useMissionStore((s) => s.status);
  const robot = useMissionStore((s) => s.robotStrip);
  const missionStatusStale = useMissionStore((s) => s.missionStatusStale);
  const robotStateStale = useMissionStore((s) => s.robotStateStale);
  const lastError = useMissionStore((s) => s.lastError);
  const authorityStatus = useControlAuthorityStore((s) => s.status);
  const runtime = useAutonomyRuntimeStore((s) => s.status);
  const runtimeStale = useAutonomyRuntimeStore((s) => s.stale);
  const [battery, setBattery] = useState<number | undefined>();
  const [missionBusy, setMissionBusy] = useState(false);

  const connected = connection.status === 'connected';
  const demo = connection.url.startsWith('demo://');

  useEffect(() => {
    if (!connected || !transport) return;
    const subscription = transport.subscribe(
      '/battery_state',
      'sensor_msgs/msg/BatteryState',
      (message) => {
        const value = Number(message?.percentage);
        if (Number.isFinite(value)) setBattery(value);
      },
      1000,
    );
    return () => subscription.unsubscribe();
  }, [connected, transport]);

  const freshRobot = robotStateStale ? null : robot;
  const activeMission = !missionStatusStale && !!mission &&
    ([MISSION_STATE.PENDING, MISSION_STATE.EXECUTING, MISSION_STATE.PAUSED] as number[])
      .includes(mission.state);
  const warning = lastError || (!demo && connected && (missionStatusStale || robotStateStale))
    ? (lastError || (language === 'zh' ? '机器人业务状态已过期，正在等待新心跳' : 'Robot runtime state is stale; waiting for fresh heartbeats'))
    : freshRobot?.estop_latched
      ? (language === 'zh' ? '急停当前处于锁止状态' : 'Emergency stop is latched')
    : freshRobot?.localization_state === LOCALIZATION_STATE.LOST
      ? (language === 'zh' ? '机器人定位已丢失' : 'Robot localization is lost')
      : null;

  const mode = useMemo(() => {
    return pc(resolveHomeModeKey({
      runtime,
      runtimeStale,
      demo,
      activeMission,
      appOwnsBaseControl: authorityStatus === 'acquired',
    }));
  }, [activeMission, authorityStatus, demo, pc, runtime, runtimeStale]);

  const authority = useMemo(() => {
    if (demo || authorityStatus === 'unsupported') return language === 'zh' ? '无需接管' : 'Not required';
    if (authorityStatus === 'acquired') return language === 'zh' ? '本机控制' : 'Mobile control';
    if (authorityStatus === 'override_acquired') return language === 'zh' ? '人工覆盖导航' : 'Manual override';
    if (authorityStatus === 'override_available') return language === 'zh' ? '导航可人工覆盖' : 'Override available';
    if (authorityStatus === 'stale') return language === 'zh' ? '状态已过期' : 'Status stale';
    if (authorityStatus === 'owned_by_other') return language === 'zh' ? '其他终端' : 'Other operator';
    return language === 'zh' ? '未接管' : 'Not acquired';
  }, [authorityStatus, demo, language]);

  const openWorkspace = (layoutId: string) => {
    if (!connected) {
      router.push('/(tabs)/device' as any);
      return;
    }
    const hasLayout = useLayoutStore.getState().layouts.some((layout) => layout.id === layoutId);
    if (hasLayout) useLayoutStore.getState().setActiveLayout(layoutId);
    router.push('/(tabs)/control');
  };

  const controlMission = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!transport || !mission?.mission_id || missionBusy) return;
    setMissionBusy(true);
    useMissionStore.getState().setError(null);
    try {
      const response = action === 'pause'
        ? await pauseMission(transport, mission.mission_id)
        : action === 'resume'
          ? await resumeMission(transport, mission.mission_id)
          : await cancelMission(transport, mission.mission_id);
      if (!response.accepted) useMissionStore.getState().setError(response.reason_text || (language === 'zh' ? '机器人拒绝了任务操作' : 'The robot rejected the mission action'));
    } catch (error: any) {
      useMissionStore.getState().setError(error?.message || String(error));
    } finally {
      setMissionBusy(false);
    }
  };

  const confirmMissionCancel = () => Alert.alert(
    language === 'zh' ? '停止当前任务' : 'Stop current mission',
    language === 'zh' ? '机器人将在安全边界停止当前巡检，是否继续？' : 'The robot will stop the inspection at a safe boundary. Continue?',
    [
      { text: language === 'zh' ? '返回' : 'Back', style: 'cancel' },
      { text: language === 'zh' ? '停止任务' : 'Stop mission', style: 'destructive', onPress: () => void controlMission('cancel') },
    ],
  );

  return (
    <SafeAreaView style={styles.safe} edges={isLandscape ? [] : ['top']}>
      <ProductHeader title={pc('home.title')} subtitle={pc('home.subtitle')} />
      <ScrollView contentContainerStyle={[styles.content, isLandscape && styles.contentLandscape]} showsVerticalScrollIndicator={false}>
        {!connected ? (
          <ProductCard emphasized style={styles.offlineCard}>
            <View style={styles.offlineIcon}><Ionicons name="hardware-chip-outline" size={34} color={theme.colors.textMuted} /></View>
            <View style={styles.offlineCopy}>
              <Text style={styles.offlineTitle}>{pc('home.noRobot')}</Text>
              <Text style={styles.offlineText}>{pc('home.noRobotHint')}</Text>
            </View>
            <ProductButton label={pc('home.connect')} icon="add" compact onPress={() => router.push('/(tabs)/device' as any)} />
          </ProductCard>
        ) : (
          <>
            <SectionHeader title={pc('home.robot')} actionLabel={pc('home.manageDevice')} onAction={() => router.push('/(tabs)/device' as any)} />
            <ProductCard emphasized>
              <View style={styles.robotTop}>
                <View style={styles.robotGlyph}><Ionicons name="hardware-chip" size={25} color={theme.colors.accentPrimary} /></View>
                <View style={styles.robotIdentity}>
                  <Text style={styles.robotName}>{robotName(connection.url, demo)}</Text>
                  <Text style={styles.robotMeta} numberOfLines={1}>{demo ? pc('home.demoRobot') : connection.url}</Text>
                </View>
                <StatusPill label={pc('home.online')} tone={demo ? 'warning' : 'success'} />
              </View>
              <View style={styles.metrics}>
                <Metric icon="battery-half" label={pc('home.battery')} value={formatBattery(freshRobot?.battery_percentage ?? battery, demo)} tone="success" />
                <Metric icon="wifi" label={pc('home.network')} value={pc('home.networkStable')} tone="success" />
                <Metric icon="navigate-circle-outline" label={pc('home.localization')} value={demo || freshRobot?.localization_state === LOCALIZATION_STATE.LOCALIZED ? pc('home.localized') : pc('home.localizationUnknown')} />
                <Metric icon="options-outline" label={pc('home.mode')} value={mode} />
              </View>
              <View style={styles.authorityRow}>
                <Text style={styles.authorityLabel}>{language === 'zh' ? '控制权' : 'Control authority'}</Text>
                <Text style={styles.authorityValue}>{authority}</Text>
              </View>
            </ProductCard>

            <View style={styles.noticeWrap}>
              <InlineNotice
                title={warning ? pc('home.warning') : pc('home.systemHealthy')}
                message={warning || pc('home.systemHealthyHint')}
                tone={warning ? 'danger' : 'success'}
                actionLabel={warning ? pc('home.viewAlerts') : undefined}
                onAction={warning ? () => router.push('/alerts' as any) : undefined}
              />
            </View>

            <View style={[styles.dashboardColumns, isLandscape && styles.dashboardColumnsLandscape]}>
              <View style={styles.column}>
                <SectionHeader title={pc('home.currentMission')} />
                <ProductCard>
                  {activeMission ? (
                    <>
                      <View style={styles.missionTop}>
                        <View style={styles.missionIcon}><Ionicons name="navigate" size={18} color={theme.colors.accentPrimary} /></View>
                        <View style={styles.missionCopy}>
                          <Text style={styles.missionName} numberOfLines={1}>{mission?.route_id || mission?.mission_id}</Text>
                          <Text style={styles.missionState}>{missionStateText(mission?.state ?? 0, language)}</Text>
                        </View>
                        <Text style={styles.progressValue}>{Math.round((mission?.progress ?? 0) * 100)}%</Text>
                      </View>
                      <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, (mission?.progress ?? 0) * 100))}%` }]} /></View>
                      <View style={styles.missionActions}>
                        <ProductButton
                          label={mission?.state === MISSION_STATE.PAUSED ? (language === 'zh' ? '继续' : 'Resume') : (language === 'zh' ? '暂停' : 'Pause')}
                          icon={mission?.state === MISSION_STATE.PAUSED ? 'play' : 'pause'}
                          compact
                          loading={missionBusy}
                          variant="secondary"
                          onPress={() => void controlMission(mission?.state === MISSION_STATE.PAUSED ? 'resume' : 'pause')}
                        />
                        <ProductButton label={language === 'zh' ? '停止' : 'Stop'} icon="stop" compact variant="danger" disabled={missionBusy} onPress={confirmMissionCancel} />
                        <ProductButton label={pc('home.manageMission')} icon="arrow-forward" compact variant="ghost" onPress={() => router.push('/(tabs)/mission')} />
                      </View>
                    </>
                  ) : (
                    <View style={styles.noMission}>
                      <Text style={styles.noMissionTitle}>{pc('home.noMission')}</Text>
                      <Text style={styles.noMissionText}>{pc('home.noMissionHint')}</Text>
                      <ProductButton label={pc('home.startMission')} icon="play" compact disabled={demo} onPress={() => router.push('/(tabs)/mission')} />
                    </View>
                  )}
                </ProductCard>
              </View>

              <View style={styles.column}>
                <SectionHeader title={pc('home.liveViews')} />
                <View style={styles.workspaceRow}>
                  <WorkspaceTile icon="map-outline" title={pc('home.map')} subtitle={pc('home.mapHint')} onPress={() => openWorkspace('nav')} />
                  <WorkspaceTile icon="videocam-outline" title={pc('home.video')} subtitle={pc('home.videoHint')} onPress={() => openWorkspace('camera-only')} />
                </View>
              </View>
            </View>

            <SectionHeader title={pc('home.quickActions')} />
            <View style={styles.quickRow}>
              <QuickAction icon="game-controller-outline" label={pc('home.manualControl')} onPress={() => openWorkspace('drive-camera')} />
              <QuickAction icon="map-outline" label={pc('home.map')} onPress={() => openWorkspace('nav')} />
              <QuickAction icon="clipboard-outline" label={pc('home.startMission')} disabled={demo} onPress={() => router.push('/(tabs)/mission')} />
              <QuickAction icon="hardware-chip-outline" label={pc('home.manageDevice')} onPress={() => router.push('/(tabs)/device' as any)} />
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function WorkspaceTile({ icon, title, subtitle, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; subtitle: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.workspaceTile} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.workspaceVisual}>
        <Ionicons name={icon} size={31} color={theme.colors.accentPrimary} />
        <View style={styles.workspaceLine} />
        <View style={[styles.workspaceLine, { width: '45%' }]} />
      </View>
      <Text style={styles.workspaceTitle}>{title}</Text>
      <Text style={styles.workspaceSubtitle}>{subtitle}</Text>
    </TouchableOpacity>
  );
}

function QuickAction({ icon, label, onPress, disabled = false }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity style={[styles.quickAction, disabled && styles.disabled]} onPress={onPress} disabled={disabled} activeOpacity={0.72}>
      <View style={styles.quickIcon}><Ionicons name={icon} size={21} color={theme.colors.textPrimary} /></View>
      <Text style={styles.quickLabel} numberOfLines={2}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bgBase },
  content: { paddingHorizontal: 18, paddingBottom: 28, width: '100%', maxWidth: theme.sizes.contentMax, alignSelf: 'center' },
  contentLandscape: { paddingHorizontal: 24 },
  offlineCard: { marginTop: 22, alignItems: 'flex-start' },
  offlineIcon: { width: 62, height: 62, alignItems: 'center', justifyContent: 'center', borderRadius: 31, backgroundColor: theme.colors.bgInset, marginBottom: 18 },
  offlineCopy: { marginBottom: 18 },
  offlineTitle: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  offlineText: { ...theme.typography.body, color: theme.colors.textMuted, marginTop: 5, maxWidth: 460 },
  robotTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  robotGlyph: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: theme.colors.accentPrimaryMuted },
  robotIdentity: { flex: 1, minWidth: 0 },
  robotName: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  robotMeta: { ...theme.typography.monoXs, color: theme.colors.textMuted, marginTop: 2 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 3, marginTop: 18, paddingTop: 13, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
  authorityRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
  authorityLabel: { ...theme.typography.bodySm, color: theme.colors.textMuted },
  authorityValue: { ...theme.typography.bodySm, color: theme.colors.textPrimary, fontWeight: '600' },
  noticeWrap: { marginTop: 12 },
  dashboardColumns: { flexDirection: 'column' },
  dashboardColumnsLandscape: { flexDirection: 'row', gap: 18 },
  column: { flex: 1, minWidth: 0 },
  missionTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  missionIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: theme.colors.accentPrimaryMuted, alignItems: 'center', justifyContent: 'center' },
  missionCopy: { flex: 1, minWidth: 0 },
  missionName: { fontSize: 15, color: theme.colors.textPrimary, fontWeight: '600' },
  missionState: { ...theme.typography.bodySm, color: theme.colors.accentPrimary, marginTop: 2 },
  progressValue: { ...theme.typography.monoMd, color: theme.colors.textPrimary },
  progressTrack: { height: 6, backgroundColor: theme.colors.bgInset, borderRadius: 3, overflow: 'hidden', marginVertical: 15 },
  progressFill: { height: 6, backgroundColor: theme.colors.accentPrimary, borderRadius: 3 },
  missionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  noMission: { alignItems: 'flex-start' },
  noMissionTitle: { fontSize: 15, color: theme.colors.textPrimary, fontWeight: '600' },
  noMissionText: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 4, marginBottom: 14 },
  workspaceRow: { flexDirection: 'row', gap: 10 },
  workspaceTile: { flex: 1, minWidth: 0, padding: 13, borderRadius: theme.radius.lg, backgroundColor: theme.colors.bgElevated, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  workspaceVisual: { height: 82, borderRadius: theme.radius.md, backgroundColor: theme.colors.bgInset, justifyContent: 'center', padding: 14, marginBottom: 11, overflow: 'hidden' },
  workspaceLine: { height: 2, width: '72%', backgroundColor: theme.colors.borderDefault, marginTop: 7 },
  workspaceTitle: { fontSize: 14, color: theme.colors.textPrimary, fontWeight: '600' },
  workspaceSubtitle: { fontSize: 11, color: theme.colors.textMuted, marginTop: 3 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickAction: { width: '47%', minHeight: 74, flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.colors.bgElevated, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  quickIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: theme.colors.bgSurface, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.colors.textPrimary, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
