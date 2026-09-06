import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { EmptyState, InlineNotice, Metric, ProductButton, ProductCard, ProductHeader, SectionHeader, StatusPill } from '../../components/ProductUI';
import { theme } from '../../constants/theme';
import { createMissionRequestEnvelope } from '../../lib/autonomy-runtime';
import { useOrientation } from '../../hooks/useOrientation';
import { useTranslation, type TranslationKey } from '../../lib/i18n';
import {
  MISSION_EVENTS_TOPIC,
  MISSION_EVENTS_TYPE,
  MISSION_STATUS_TOPIC,
  MISSION_STATUS_TYPE,
  ROBOT_STATE_TOPIC,
  ROBOT_STATE_TYPE,
  cancelMission,
  dispatchMission,
  listRoutes,
  pauseMission,
  resumeMission,
} from '../../lib/mission/api';
import {
  ACTIVE_MISSION_STATES,
  LOCALIZATION_STATE,
  MISSION_EVENT,
  MISSION_STATE,
  type ControlResponse,
} from '../../lib/mission/types';
import { useMissionStore } from '../../stores/useMissionStore';
import { useRosStore } from '../../stores/useRosStore';

const STATE_LABELS: Record<number, TranslationKey> = {
  [MISSION_STATE.NONE]: 'mission.state.none',
  [MISSION_STATE.PENDING]: 'mission.state.pending',
  [MISSION_STATE.EXECUTING]: 'mission.state.executing',
  [MISSION_STATE.PAUSED]: 'mission.state.paused',
  [MISSION_STATE.SUCCEEDED]: 'mission.state.succeeded',
  [MISSION_STATE.CANCELED]: 'mission.state.canceled',
  [MISSION_STATE.FAILED]: 'mission.state.failed',
  [MISSION_STATE.INTERRUPTED]: 'mission.state.interrupted',
};

const EVENT_LABELS: Record<number, TranslationKey> = {
  [MISSION_EVENT.DISPATCHED]: 'mission.event.dispatched',
  [MISSION_EVENT.STARTED]: 'mission.event.started',
  [MISSION_EVENT.PAUSED]: 'mission.event.paused',
  [MISSION_EVENT.RESUMED]: 'mission.event.resumed',
  [MISSION_EVENT.CANCELED]: 'mission.event.canceled',
  [MISSION_EVENT.SUCCEEDED]: 'mission.event.succeeded',
  [MISSION_EVENT.FAILED]: 'mission.event.failed',
  [MISSION_EVENT.INTERRUPTED]: 'mission.event.interrupted',
};

const LOC_LABELS: Record<number, TranslationKey> = {
  [LOCALIZATION_STATE.UNKNOWN]: 'mission.loc.unknown',
  [LOCALIZATION_STATE.DEGRADED]: 'mission.loc.degraded',
  [LOCALIZATION_STATE.LOST]: 'mission.loc.lost',
  [LOCALIZATION_STATE.LOCALIZED]: 'mission.loc.localized',
};

const REASON_LABELS: Record<number, TranslationKey> = {
  0: 'mission.reason.ok',
  1: 'mission.reason.rejected',
  2: 'mission.reason.duplicate',
  3: 'mission.reason.routeNotFound',
  4: 'mission.reason.mapMismatch',
  5: 'mission.reason.localizationNotReady',
  6: 'mission.reason.controlDenied',
  7: 'mission.reason.userCanceled',
  8: 'mission.reason.missionFailed',
  9: 'mission.reason.missionInterrupted',
};

function stateColor(state: number): string {
  switch (state) {
    case MISSION_STATE.PENDING:
    case MISSION_STATE.EXECUTING:
      return theme.colors.accentPrimary;
    case MISSION_STATE.PAUSED:
      return theme.colors.statusConnecting;
    case MISSION_STATE.SUCCEEDED:
      return theme.colors.statusConnected;
    case MISSION_STATE.CANCELED:
      return theme.colors.statusDisconnected;
    default:
      return theme.colors.statusError;
  }
}

export default function MissionTab() {
  const status = useRosStore((s) => s.connection.status);
  const transport = useRosStore((s) => s.transport);
  const url = useRosStore((s) => s.connection.url);
  const { t, language } = useTranslation();
  const router = useRouter();
  const { isLandscape } = useOrientation();

  const routes = useMissionStore((s) => s.routes);
  const routesLoaded = useMissionStore((s) => s.routesLoaded);
  const selectedRouteId = useMissionStore((s) => s.selectedRouteId);
  const mission = useMissionStore((s) => s.status);
  const events = useMissionStore((s) => s.events);
  const robotStrip = useMissionStore((s) => s.robotStrip);
  const dispatching = useMissionStore((s) => s.dispatching);
  const controlling = useMissionStore((s) => s.controlling);
  const lastError = useMissionStore((s) => s.lastError);

  const connected =
    status === 'connected' && !!transport && !url?.startsWith('demo://');

  // ---- live feed: status (transient_local snapshot), events, robot state ----
  useEffect(() => {
    if (!connected || !transport) {
      useMissionStore.getState().resetFeed();
      return;
    }
    const subscriptions = [
      transport.subscribe(
        MISSION_STATUS_TOPIC,
        MISSION_STATUS_TYPE,
        (message) => useMissionStore.getState().onStatus(message),
      ),
      transport.subscribe(
        MISSION_EVENTS_TOPIC,
        MISSION_EVENTS_TYPE,
        (message) => useMissionStore.getState().onEvent(message),
      ),
      transport.subscribe(
        ROBOT_STATE_TOPIC,
        ROBOT_STATE_TYPE,
        (message) => useMissionStore.getState().onRobotState(message),
      ),
    ];
    listRoutes(transport)
      .then((list) => useMissionStore.getState().setRoutes(list))
      .catch(() => {});
    return () => {
      subscriptions.forEach((sub) => sub.unsubscribe());
      useMissionStore.getState().resetFeed();
    };
  }, [connected, transport]);

  // ---- dispatch (idempotent per request_id) ----
  const runDispatch = useCallback(
    async (routeId: string) => {
      const store = useMissionStore.getState();
      // Reuse the key of a pending intent for this route: a retry after a
      // bridge flake is a replay the Manager answers with the original
      // outcome, not a second dispatch.
      const pending = store.pendingDispatch;
      const request = pending && pending.routeId === routeId
        ? pending
        : { ...createMissionRequestEnvelope('inspection', 30), routeId };
      const route = store.routes.find((entry) => entry.routeId === routeId);
      if (!route) {
        store.setError(t('mission.reason.routeNotFound'));
        return;
      }
      store.setPendingDispatch(request);
      store.setDispatching(true);
      store.setError(null);
      try {
        const response = await dispatchMission(transport!, {
          routeId,
          requestId: request.requestId,
          sequence: request.sequence,
          source: request.source,
          requestedAt: request.requestedAt,
          deadline: request.deadline,
          mapId: route.mapId,
          mapVersion: route.mapVersion,
          mapChecksum: route.mapChecksum,
          routeChecksum: route.routeChecksum,
        });
        if (response.accepted) {
          store.setPendingDispatch(null);
        } else {
          store.setError(
            response.reason_text ||
              t(REASON_LABELS[response.reason_code] ?? 'mission.reason.rejected'),
          );
        }
      } catch (error: any) {
        // Bridge/network failure: keep the intent so the next tap replays
        // the same (request_id, sequence).
        store.setError(error?.message || String(error));
      } finally {
        useMissionStore.getState().setDispatching(false);
      }
    },
    [transport, t],
  );

  const onDispatchPress = useCallback(() => {
    if (!selectedRouteId) return;
    Alert.alert(
      t('mission.dispatchConfirmTitle'),
      t('mission.dispatchConfirmMessage', { route: selectedRouteId }),
      [
        { text: t('mission.cancel'), style: 'cancel' },
        {
          text: t('mission.dispatch'),
          style: 'default',
          onPress: () => void runDispatch(selectedRouteId),
        },
      ],
    );
  }, [selectedRouteId, runDispatch, t]);

  // ---- pause / resume / cancel ----
  const runControl = useCallback(
    async (call: (mid?: string) => Promise<ControlResponse>) => {
      const mid = mission?.mission_id || undefined;
      const store = useMissionStore.getState();
      store.setControlling(true);
      store.setError(null);
      try {
        const response = await call(mid);
        if (!response.accepted) {
          store.setError(
            response.reason_text ||
              t(REASON_LABELS[response.reason_code] ?? 'mission.reason.rejected'),
          );
        }
      } catch (error: any) {
        store.setError(error?.message || String(error));
      } finally {
        useMissionStore.getState().setControlling(false);
      }
    },
    [mission?.mission_id, t],
  );

  const onCancelPress = useCallback(() => {
    Alert.alert(
      t('mission.cancelConfirmTitle'),
      t('mission.cancelConfirmMessage'),
      [
        { text: t('mission.cancel'), style: 'cancel' },
        {
          text: t('mission.confirmCancel'),
          style: 'destructive',
          onPress: () => void runControl((mid) => cancelMission(transport!, mid)),
        },
      ],
    );
  }, [runControl, transport, t]);

  const missionState = mission?.state ?? MISSION_STATE.NONE;
  const missionActive = ACTIVE_MISSION_STATES.includes(missionState);

  const progress = mission && missionState !== MISSION_STATE.NONE
    ? Math.max(0, Math.min(1, mission.progress || 0))
    : 0;

  return (
    <SafeAreaView style={styles.safe} edges={isLandscape ? [] : ['top']}>
      <ProductHeader title={language === 'zh' ? '巡检任务' : 'Missions'} subtitle={language === 'zh' ? '路线派发与执行状态' : 'Routes and execution status'} />
      {!connected ? (
        <EmptyState
          icon="clipboard-outline"
          title={t('mission.notConnected')}
          message={url?.startsWith('demo://') ? (language === 'zh' ? '演示模式不向任务管理器发送指令，请连接真实机器人后管理巡检。' : 'Demo mode does not send commands to the Mission Manager. Connect a real robot to manage inspections.') : t('mission.notConnectedHint')}
          actionLabel={language === 'zh' ? '连接机器人' : 'Connect a robot'}
          onAction={() => router.push('/(tabs)/device' as any)}
        />
      ) : (
        <ScrollView contentContainerStyle={[styles.scroll, isLandscape && styles.scrollLandscape]} showsVerticalScrollIndicator={false}>
          {lastError ? <InlineNotice title={language === 'zh' ? '任务操作失败' : 'Mission action failed'} message={lastError} tone="danger" actionLabel={language === 'zh' ? '关闭' : 'Dismiss'} onAction={() => useMissionStore.getState().setError(null)} /> : null}

          <SectionHeader title={t('mission.missionCard')} />
          {missionState === MISSION_STATE.NONE ? (
            <ProductCard><View style={styles.noMissionRow}><View style={styles.routeIcon}><Ionicons name="checkmark-circle-outline" size={22} color={theme.colors.statusConnected} /></View><View style={styles.routeMain}><Text style={styles.noMissionTitle}>{t('mission.noActiveMission')}</Text><Text style={styles.muted}>{language === 'zh' ? '选择下方路线即可开始新的巡检。' : 'Choose a route below to start a new inspection.'}</Text></View></View></ProductCard>
          ) : (
            <ProductCard emphasized>
              <View style={styles.cardRow}><View style={styles.routeMain}><Text style={styles.activeRoute}>{mission?.route_id || mission?.mission_id}</Text><Text style={styles.activeMeta} numberOfLines={1}>{mission?.mission_id}</Text></View><StatusPill label={t(STATE_LABELS[missionState] ?? 'mission.state.none')} tone={missionState === MISSION_STATE.PAUSED ? 'warning' : missionState === MISSION_STATE.FAILED ? 'danger' : missionState === MISSION_STATE.SUCCEEDED ? 'success' : 'primary'} /></View>
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: stateColor(missionState) }]} /></View>
              <View style={styles.cardRow}><Text style={styles.progressLabel}>{language === 'zh' ? '巡检进度' : 'Inspection progress'}</Text><Text style={styles.progressValue}>{Math.round(progress * 100)}%</Text></View>
              {mission?.reason_text ? <Text style={styles.cardReason}>{mission.reason_text}</Text> : null}
              {missionActive ? <View style={styles.controlRow}><ProductButton label={t('mission.pause')} icon="pause" variant="secondary" disabled={controlling || missionState === MISSION_STATE.PAUSED} onPress={() => void runControl((mid) => pauseMission(transport!, mid))} /><ProductButton label={t('mission.resume')} icon="play" variant="secondary" disabled={controlling || missionState !== MISSION_STATE.PAUSED} onPress={() => void runControl((mid) => resumeMission(transport!, mid))} /><ProductButton label={t('mission.cancel')} icon="stop" variant="danger" disabled={controlling} onPress={onCancelPress} /></View> : null}
            </ProductCard>
          )}

          <SectionHeader title={t('mission.robot')} />
          <ProductCard><View style={styles.robotMetrics}>
            <Metric icon="navigate-circle-outline" label={language === 'zh' ? '定位' : 'Localization'} value={t(LOC_LABELS[robotStrip?.localization_state ?? LOCALIZATION_STATE.UNKNOWN] ?? 'mission.loc.unknown')} tone={robotStrip?.localization_state === LOCALIZATION_STATE.LOCALIZED ? 'success' : 'warning'} />
            <Metric icon="map-outline" label={language === 'zh' ? '地图' : 'Map'} value={robotStrip?.map_id || t('mission.none')} />
            <Metric icon="battery-half-outline" label={language === 'zh' ? '电量' : 'Battery'} value={Number.isFinite(robotStrip?.battery_percentage ?? NaN) ? `${Math.round(robotStrip!.battery_percentage <= 1 ? robotStrip!.battery_percentage * 100 : robotStrip!.battery_percentage)}%` : t('mission.none')} />
            <Metric icon="shield-checkmark-outline" label={language === 'zh' ? '安全' : 'Safety'} value={robotStrip?.estop_latched ? t('mission.estop') : (language === 'zh' ? '正常' : 'Ready')} tone={robotStrip?.estop_latched ? 'danger' : 'success'} />
          </View></ProductCard>

          <SectionHeader title={t('mission.routes')} />
          <ProductCard style={styles.routesCard}>
            {!routesLoaded ? <View style={styles.loadingRow}><Ionicons name="sync-outline" size={18} color={theme.colors.textMuted} /><Text style={styles.muted}>{t('mission.routesLoading')}</Text></View> : routes.length === 0 ? <Text style={styles.muted}>{t('mission.noRoutes')}</Text> : routes.map((route) => {
              const selected = route.routeId === selectedRouteId;
              const version = route.mapVersion
                ? (route.mapVersion.startsWith('v') ? route.mapVersion : `v${route.mapVersion}`)
                : '';
              const assetMeta = [
                route.mapId
                  ? `${t('mission.routeMap', { map: route.mapId })}${version ? ` · ${version}` : ''}`
                  : t('mission.routeUnbound'),
                route.pointCount > 0 ? `${route.pointCount}${language === 'zh' ? '点' : ' pts'}` : '',
                route.distanceM > 0 ? `${route.distanceM.toFixed(1)} m` : '',
              ].filter(Boolean).join(' · ');
              return <TouchableOpacity key={route.routeId} style={[styles.routeRow, selected && styles.routeRowSelected]} activeOpacity={0.75} onPress={() => useMissionStore.getState().selectRoute(selected ? null : route.routeId)}><View style={[styles.routeIcon, selected && styles.routeIconSelected]}><Ionicons name="git-branch-outline" size={19} color={selected ? theme.colors.accentPrimary : theme.colors.textSecondary} /></View><View style={styles.routeMain}><Text style={styles.routeId}>{route.routeId}</Text><Text style={styles.muted} numberOfLines={1}>{assetMeta}</Text></View><Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={21} color={selected ? theme.colors.accentPrimary : theme.colors.borderDefault} /></TouchableOpacity>;
            })}
            <ProductButton label={dispatching ? t('mission.dispatching') : t('mission.dispatch')} icon="send" loading={dispatching} disabled={!selectedRouteId || dispatching} onPress={onDispatchPress} />
          </ProductCard>

          <SectionHeader title={language === 'zh' ? '最近动态' : 'Recent activity'} />
          {events.length === 0 ? <ProductCard><Text style={styles.muted}>{t('mission.noEvents')}</Text></ProductCard> : <ProductCard style={styles.eventsCard}>{events.map((event, index) => <View key={`${event.mission_id}-${event.sequence}`} style={[styles.eventRow, index === events.length - 1 && styles.eventRowLast]}><View style={styles.timeline}><View style={styles.timelineDot} />{index < events.length - 1 ? <View style={styles.timelineLine} /> : null}</View><View style={styles.eventCopy}><Text style={styles.eventLabel}>{t(EVENT_LABELS[event.event] ?? 'mission.event.dispatched')}</Text><Text style={styles.muted} numberOfLines={2}>{event.reason_text || event.mission_id}</Text></View><Text style={styles.eventSeq}>#{event.sequence}</Text></View>)}</ProductCard>}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bgBase },
  scroll: { width: '100%', maxWidth: theme.sizes.contentMax, alignSelf: 'center', paddingHorizontal: 18, paddingBottom: 32 },
  scrollLandscape: { maxWidth: 960, paddingHorizontal: 24 },
  muted: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 17 },
  noMissionRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  noMissionTitle: { fontSize: 15, fontWeight: '600', color: theme.colors.textPrimary, marginBottom: 3 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  activeRoute: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  activeMeta: { ...theme.typography.monoXs, color: theme.colors.textMuted, marginTop: 3 },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: theme.colors.bgInset, overflow: 'hidden', marginTop: 16, marginBottom: 10 },
  progressFill: { height: '100%', borderRadius: 4 },
  progressLabel: { ...theme.typography.bodySm, color: theme.colors.textMuted },
  progressValue: { ...theme.typography.monoMd, color: theme.colors.textPrimary },
  cardReason: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 8 },
  controlRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  robotMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  routesCard: { paddingTop: 4, gap: 12 },
  routeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  routeRowSelected: { backgroundColor: theme.colors.accentPrimaryMuted, borderRadius: theme.radius.md, paddingHorizontal: 10, borderBottomColor: theme.colors.accentPrimary + '55' },
  routeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgSurface },
  routeIconSelected: { backgroundColor: theme.colors.accentPrimaryMuted },
  routeMain: { flex: 1, minWidth: 0 },
  routeId: { fontSize: 14, fontWeight: '600', color: theme.colors.textValue, marginBottom: 2 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  eventsCard: { paddingVertical: 4 },
  eventRow: { minHeight: 58, flexDirection: 'row', alignItems: 'stretch', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  eventRowLast: { borderBottomWidth: 0 },
  eventCopy: { flex: 1, minWidth: 0, justifyContent: 'center' },
  eventLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.textValue, marginBottom: 2 },
  eventSeq: { ...theme.typography.monoXs, color: theme.colors.textMuted, alignSelf: 'center' },
  timeline: { width: 20, alignItems: 'center' },
  timelineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accentPrimary, marginTop: 8 },
  timelineLine: { width: 1, flex: 1, backgroundColor: theme.colors.borderDefault, marginTop: 4 },
});
