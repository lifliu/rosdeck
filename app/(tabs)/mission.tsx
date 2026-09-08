import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { EmptyState, InlineNotice, Metric, ProductButton, ProductCard, ProductHeader, SectionHeader, StatusPill } from '../../components/ProductUI';
import { RouteCheckpointEditor } from '../../components/RouteCheckpointEditor';
import { theme } from '../../constants/theme';
import { createMissionRequestEnvelope } from '../../lib/autonomy-runtime';
import { useOrientation } from '../../hooks/useOrientation';
import { useTranslation, type TranslationKey } from '../../lib/i18n';
import {
  DEFAULT_INSPECTION_COMMAND_TTL_SEC,
  cancelMission,
  dispatchMission,
  getCheckpointResults,
  listRoutes,
  pauseMission,
  resumeMission,
} from '../../lib/mission/api';
import {
  ACTIVE_MISSION_STATES,
  CHECKPOINT_RESULT_STATUS,
  getRouteDispatchBlockReason,
  LOCALIZATION_STATE,
  MISSION_EVENT,
  MISSION_STATE,
  type ControlResponse,
  type CheckpointEvidenceResult,
  type RouteDispatchBlockReason,
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

const ROUTE_BLOCK_LABELS: Record<RouteDispatchBlockReason, TranslationKey> = {
  legacy_map_binding: 'mission.routeLegacyMapBinding',
  unsupported_frame: 'mission.routeUnsupportedFrame',
  malformed_route: 'mission.routeMalformed',
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
  const [checkpointEditorOpen, setCheckpointEditorOpen] = useState(false);

  const routes = useMissionStore((s) => s.routes);
  const routesLoaded = useMissionStore((s) => s.routesLoaded);
  const selectedRouteId = useMissionStore((s) => s.selectedRouteId);
  const mission = useMissionStore((s) => s.status);
  const events = useMissionStore((s) => s.events);
  const robotStrip = useMissionStore((s) => s.robotStrip);
  const missionStatusStale = useMissionStore((s) => s.missionStatusStale);
  const robotStateStale = useMissionStore((s) => s.robotStateStale);
  const dispatching = useMissionStore((s) => s.dispatching);
  const controlling = useMissionStore((s) => s.controlling);
  const lastError = useMissionStore((s) => s.lastError);
  const [checkpointResults, setCheckpointResults] = useState<CheckpointEvidenceResult[]>([]);
  const [checkpointResultsLoading, setCheckpointResultsLoading] = useState(false);
  const [checkpointResultsError, setCheckpointResultsError] = useState('');
  const checkpointResultsRequestSerial = useRef(0);

  const connected =
    status === 'connected' && !!transport && !url?.startsWith('demo://');

  const refreshRoutes = useCallback(async (showError = false) => {
    if (!connected || !transport) return;
    useMissionStore.getState().beginRoutesRefresh();
    try {
      const list = await listRoutes(transport);
      useMissionStore.getState().setRoutes(list);
    } catch (error: any) {
      // 本次权威目录读取失败后，旧机器人路线仍不得回填；同时结束加载态，
      // 避免页面永久停留在“正在读取路线”。
      useMissionStore.getState().setRoutes([]);
      if (showError) {
        useMissionStore.getState().setError(error?.message || String(error));
      }
    }
  }, [connected, transport]);

  const refreshCheckpointResults = useCallback(async (
    missionId: string,
    showError = false,
  ) => {
    const serial = ++checkpointResultsRequestSerial.current;
    if (!connected || !transport || !missionId) {
      setCheckpointResults([]);
      setCheckpointResultsError('');
      setCheckpointResultsLoading(false);
      return;
    }
    setCheckpointResultsLoading(true);
    if (showError) setCheckpointResultsError('');
    try {
      const results = await getCheckpointResults(transport, missionId);
      if (serial === checkpointResultsRequestSerial.current) {
        setCheckpointResults(results);
      }
    } catch (error: any) {
      if (serial === checkpointResultsRequestSerial.current) {
        setCheckpointResults([]);
        if (showError) setCheckpointResultsError(error?.message || String(error));
      }
    } finally {
      if (serial === checkpointResultsRequestSerial.current) {
        setCheckpointResultsLoading(false);
      }
    }
  }, [connected, transport]);

  // Expo Tabs 会保留页面实例。录线页保存新资产后再切回本页时，
  // 必须按焦点重读机器人端目录，不能继续显示上次挂载时的缓存。
  useFocusEffect(
    useCallback(() => {
      void refreshRoutes();
      const missionId = useMissionStore.getState().status?.mission_id ?? '';
      if (missionId) void refreshCheckpointResults(missionId);
    }, [refreshCheckpointResults, refreshRoutes]),
  );

  // 任务身份切换时立即丢弃上一任务的证据，并使仍在飞行的旧查询失效。
  // 否则新任务执行期间可能短暂显示上一任务的照片或识别结果。
  useEffect(() => {
    checkpointResultsRequestSerial.current += 1;
    setCheckpointResults([]);
    setCheckpointResultsError('');
    setCheckpointResultsLoading(false);
  }, [mission?.mission_id]);

  // 任务进入终态时从 SQLite 权威查询结果；不能依赖手机在线期间恰好收到 live topic。
  useEffect(() => {
    if (!missionStatusStale && mission?.mission_id &&
      !ACTIVE_MISSION_STATES.includes(mission.state)) {
      void refreshCheckpointResults(mission.mission_id);
    }
  }, [mission?.mission_id, mission?.state, missionStatusStale, refreshCheckpointResults]);

  // 派发请求以 request_id 保证幂等；确认后仍需按最新 Store 做最终门禁。
  const runDispatch = useCallback(
    async (routeId: string) => {
      const store = useMissionStore.getState();
      // 网络闪断后的重试沿用同一路线的 request_id，Mission Manager 会返回
      // 原请求结果，不会创建第二个任务。
      const pending = store.pendingDispatch;
      const request = pending && pending.routeId === routeId
        ? pending
        : {
          ...createMissionRequestEnvelope(
            'inspection',
            DEFAULT_INSPECTION_COMMAND_TTL_SEC,
          ),
          routeId,
        };
      const route = store.routes.find((entry) => entry.routeId === routeId);
      if (!route) {
        store.setError(t('mission.reason.routeNotFound'));
        return;
      }
      const blockReason = getRouteDispatchBlockReason(route);
      if (blockReason) {
        store.setError(t(ROUTE_BLOCK_LABELS[blockReason]));
        return;
      }
      if (store.robotStateStale || !store.robotStrip) {
        store.setError(t('mission.robotStateUnavailable'));
        return;
      }
      if (store.missionStatusStale) {
        store.setError(t('mission.missionStateUnavailable'));
        return;
      }
      if (
        store.status &&
        ACTIVE_MISSION_STATES.includes(store.status.state)
      ) {
        store.setError(t('mission.activeBlocksDispatch'));
        return;
      }
      if (store.robotStrip.estop_latched) {
        store.setError(t('mission.estopBlocksDispatch'));
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
        // 传输失败时保留意图，下一次点击会重放相同 request_id/sequence。
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
  const missionActive = !missionStatusStale &&
    ACTIVE_MISSION_STATES.includes(missionState);
  const freshRobotStrip = robotStateStale ? null : robotStrip;
  const selectedRoute = routes.find(
    (route) => route.routeId === selectedRouteId,
  );
  const selectedRouteBlocked = selectedRoute
    ? getRouteDispatchBlockReason(selectedRoute)
    : null;
  const dispatchBlockedByRobot = robotStateStale || !robotStrip
    ? 'mission.robotStateUnavailable' as const
    : missionStatusStale
      ? 'mission.missionStateUnavailable' as const
      : robotStrip.estop_latched
        ? 'mission.estopBlocksDispatch' as const
        : missionActive
          ? 'mission.activeBlocksDispatch' as const
          : null;

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
          {missionStatusStale || robotStateStale ? <InlineNotice title={language === 'zh' ? '状态已过期' : 'Status is stale'} message={language === 'zh' ? '正在等待 Mission Manager 和机器人的新心跳，期间已禁止派发和任务控制。' : 'Waiting for fresh Mission Manager and robot heartbeats. Dispatch and mission control are disabled.'} tone="warning" /> : null}

          <SectionHeader title={t('mission.missionCard')} />
          {missionState === MISSION_STATE.NONE ? (
            <ProductCard><View style={styles.noMissionRow}><View style={styles.routeIcon}><Ionicons name="checkmark-circle-outline" size={22} color={theme.colors.statusConnected} /></View><View style={styles.routeMain}><Text style={styles.noMissionTitle}>{t('mission.noActiveMission')}</Text><Text style={styles.muted}>{language === 'zh' ? '选择下方路线即可开始新的巡检。' : 'Choose a route below to start a new inspection.'}</Text></View></View></ProductCard>
          ) : (
            <ProductCard emphasized>
              <View style={styles.cardRow}><View style={styles.routeMain}><Text style={styles.activeRoute}>{mission?.route_id || mission?.mission_id}</Text><Text style={styles.activeMeta} numberOfLines={1}>{mission?.mission_id}</Text></View><StatusPill label={t(STATE_LABELS[missionState] ?? 'mission.state.none')} tone={missionState === MISSION_STATE.PAUSED ? 'warning' : missionState === MISSION_STATE.FAILED ? 'danger' : missionState === MISSION_STATE.SUCCEEDED ? 'success' : 'primary'} /></View>
              <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: stateColor(missionState) }]} /></View>
              <View style={styles.cardRow}><Text style={styles.progressLabel}>{language === 'zh' ? '巡检进度' : 'Inspection progress'}</Text><Text style={styles.progressValue}>{Math.round(progress * 100)}%</Text></View>
              {mission?.current_checkpoint_id ? <Text style={styles.checkpointNow}>{language === 'zh' ? '当前检查点' : 'Checkpoint'} · {mission.current_checkpoint_id}</Text> : null}
              {mission?.status_text ? <Text style={styles.cardReason}>{mission.status_text}</Text> : null}
              {mission?.reason_text ? <Text style={styles.cardReason}>{mission.reason_text}</Text> : null}
              {missionActive ? <View style={styles.controlRow}><ProductButton label={t('mission.pause')} icon="pause" variant="secondary" disabled={controlling || missionState === MISSION_STATE.PAUSED} onPress={() => void runControl((mid) => pauseMission(transport!, mid))} /><ProductButton label={t('mission.resume')} icon="play" variant="secondary" disabled={controlling || missionState !== MISSION_STATE.PAUSED} onPress={() => void runControl((mid) => resumeMission(transport!, mid))} /><ProductButton label={t('mission.cancel')} icon="stop" variant="danger" disabled={controlling} onPress={onCancelPress} /></View> : null}
            </ProductCard>
          )}

          <SectionHeader title={t('mission.robot')} />
          <ProductCard><View style={styles.robotMetrics}>
            <Metric icon="navigate-circle-outline" label={language === 'zh' ? '定位' : 'Localization'} value={t(LOC_LABELS[freshRobotStrip?.localization_state ?? LOCALIZATION_STATE.UNKNOWN] ?? 'mission.loc.unknown')} tone={freshRobotStrip?.localization_state === LOCALIZATION_STATE.LOCALIZED ? 'success' : 'warning'} />
            <Metric icon="map-outline" label={language === 'zh' ? '地图' : 'Map'} value={freshRobotStrip?.map_id || t('mission.none')} />
            <Metric icon="battery-half-outline" label={language === 'zh' ? '电量' : 'Battery'} value={Number.isFinite(freshRobotStrip?.battery_percentage ?? NaN) ? `${Math.round(freshRobotStrip!.battery_percentage <= 1 ? freshRobotStrip!.battery_percentage * 100 : freshRobotStrip!.battery_percentage)}%` : t('mission.none')} />
            <Metric icon="shield-checkmark-outline" label={language === 'zh' ? '安全' : 'Safety'} value={freshRobotStrip?.estop_latched ? t('mission.estop') : freshRobotStrip ? (language === 'zh' ? '正常' : 'Ready') : t('mission.none')} tone={freshRobotStrip?.estop_latched ? 'danger' : freshRobotStrip ? 'success' : 'warning'} />
          </View></ProductCard>

          <SectionHeader
            title={t('mission.routes')}
            actionLabel={language === 'zh' ? '刷新' : 'Refresh'}
            onAction={() => void refreshRoutes(true)}
          />
          <ProductCard style={styles.routesCard}>
            {!routesLoaded ? <View style={styles.loadingRow}><Ionicons name="sync-outline" size={18} color={theme.colors.textMuted} /><Text style={styles.muted}>{t('mission.routesLoading')}</Text></View> : routes.length === 0 ? <Text style={styles.muted}>{t('mission.noRoutes')}</Text> : routes.map((route) => {
              const blockReason = getRouteDispatchBlockReason(route);
              const blocked = blockReason !== null;
              const selected = !blocked && route.routeId === selectedRouteId;
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
              return <TouchableOpacity key={route.routeId} style={[styles.routeRow, selected && styles.routeRowSelected, blocked && styles.routeRowBlocked]} activeOpacity={0.75} accessibilityState={{ disabled: blocked, selected }} onPress={() => {
                if (blockReason) {
                  useMissionStore.getState().setError(t(ROUTE_BLOCK_LABELS[blockReason]));
                  return;
                }
                useMissionStore.getState().selectRoute(selected ? null : route.routeId);
              }}><View style={[styles.routeIcon, selected && styles.routeIconSelected]}><Ionicons name={blocked ? 'warning-outline' : 'git-branch-outline'} size={19} color={blocked ? theme.colors.statusConnecting : selected ? theme.colors.accentPrimary : theme.colors.textSecondary} /></View><View style={styles.routeMain}><Text style={[styles.routeId, blocked && styles.routeIdBlocked]}>{route.routeId}</Text><Text style={styles.muted} numberOfLines={1}>{assetMeta}</Text>{blockReason ? <Text style={styles.routeBlockReason}>{t(ROUTE_BLOCK_LABELS[blockReason])}</Text> : null}</View><Ionicons name={selected ? 'checkmark-circle' : blocked ? 'alert-circle-outline' : 'ellipse-outline'} size={21} color={selected ? theme.colors.accentPrimary : blocked ? theme.colors.statusConnecting : theme.colors.borderDefault} /></TouchableOpacity>;
            })}
            <View style={styles.routeActions}>
              <ProductButton
                label={language === 'zh' ? '编辑检查点' : 'Edit checkpoints'}
                icon="create-outline"
                variant="secondary"
                disabled={!selectedRoute || !!selectedRouteBlocked || missionActive || dispatching}
                onPress={() => setCheckpointEditorOpen(true)}
              />
              <ProductButton label={dispatching ? t('mission.dispatching') : t('mission.dispatch')} icon="send" loading={dispatching} disabled={!selectedRouteId || !!selectedRouteBlocked || !!dispatchBlockedByRobot || dispatching} onPress={onDispatchPress} />
            </View>
            {dispatchBlockedByRobot ? <Text style={styles.dispatchBlockReason}>{t(dispatchBlockedByRobot)}</Text> : null}
          </ProductCard>

          <SectionHeader title={language === 'zh' ? '最近动态' : 'Recent activity'} />
          {events.length === 0 ? <ProductCard><Text style={styles.muted}>{t('mission.noEvents')}</Text></ProductCard> : <ProductCard style={styles.eventsCard}>{events.map((event, index) => <View key={`${event.mission_id}-${event.sequence}`} style={[styles.eventRow, index === events.length - 1 && styles.eventRowLast]}><View style={styles.timeline}><View style={styles.timelineDot} />{index < events.length - 1 ? <View style={styles.timelineLine} /> : null}</View><View style={styles.eventCopy}><Text style={styles.eventLabel}>{t(EVENT_LABELS[event.event] ?? 'mission.event.dispatched')}</Text><Text style={styles.muted} numberOfLines={2}>{event.reason_text || event.mission_id}</Text></View><Text style={styles.eventSeq}>#{event.sequence}</Text></View>)}</ProductCard>}

          {mission?.mission_id ? <>
            <SectionHeader
              title={language === 'zh' ? '检查点结果' : 'Checkpoint results'}
              actionLabel={language === 'zh' ? '刷新' : 'Refresh'}
              onAction={() => void refreshCheckpointResults(mission.mission_id, true)}
            />
            <ProductCard style={styles.resultsCard}>
              {checkpointResultsLoading ? <View style={styles.loadingRow}><Ionicons name="sync-outline" size={18} color={theme.colors.textMuted} /><Text style={styles.muted}>{language === 'zh' ? '正在读取持久结果…' : 'Loading durable results…'}</Text></View> : checkpointResultsError ? <Text style={styles.resultError}>{checkpointResultsError}</Text> : checkpointResults.length === 0 ? <Text style={styles.muted}>{language === 'zh' ? '当前任务还没有拍照、录像或识别结果。停留动作不产生证据记录。' : 'No photo, recording, or recognition results yet. Dwell actions do not create evidence records.'}</Text> : checkpointResults.map((result) => {
                const succeeded = result.status === CHECKPOINT_RESULT_STATUS.SUCCEEDED;
                const skipped = result.status === CHECKPOINT_RESULT_STATUS.SKIPPED;
                const resultText = result.resultJson || result.artifactPath || result.reason;
                return <View key={`${result.missionId}-${result.sequence}`} style={styles.resultRow}><View style={[styles.resultIcon, succeeded ? styles.resultIconSuccess : skipped ? styles.resultIconWarning : styles.resultIconDanger]}><Ionicons name={succeeded ? 'checkmark' : skipped ? 'play-skip-forward' : 'close'} size={16} color={succeeded ? theme.colors.statusConnected : skipped ? theme.colors.statusConnecting : theme.colors.statusError} /></View><View style={styles.resultMain}><Text style={styles.resultTitle}>{result.checkpointId} · {result.actionType}</Text><Text style={styles.muted}>{language === 'zh' ? `尝试 ${result.attempts} 次` : `${result.attempts} attempt(s)`}{result.poseValid ? (language === 'zh' ? ' · 位姿已记录' : ' · pose recorded') : ''}</Text>{resultText ? <Text style={styles.resultDetail} numberOfLines={2}>{resultText}</Text> : null}</View><Text style={styles.eventSeq}>#{result.sequence}</Text></View>;
              })}
            </ProductCard>
          </> : null}
        </ScrollView>
      )}
      <RouteCheckpointEditor
        visible={checkpointEditorOpen}
        route={selectedRoute ?? null}
        onCancel={() => setCheckpointEditorOpen(false)}
        onSaved={async () => {
          const routeId = selectedRoute?.routeId ?? '';
          await refreshRoutes(true);
          if (routeId) useMissionStore.getState().selectRoute(routeId);
        }}
      />
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
  checkpointNow: { marginTop: 9, color: theme.colors.accentPrimary, fontSize: 12, fontWeight: '600' },
  controlRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  robotMetrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  routesCard: { paddingTop: 4, gap: 12 },
  routeActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  routeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  routeRowSelected: { backgroundColor: theme.colors.accentPrimaryMuted, borderRadius: theme.radius.md, paddingHorizontal: 10, borderBottomColor: theme.colors.accentPrimary + '55' },
  routeRowBlocked: { opacity: 0.72 },
  routeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgSurface },
  routeIconSelected: { backgroundColor: theme.colors.accentPrimaryMuted },
  routeMain: { flex: 1, minWidth: 0 },
  routeId: { fontSize: 14, fontWeight: '600', color: theme.colors.textValue, marginBottom: 2 },
  routeIdBlocked: { color: theme.colors.textSecondary },
  routeBlockReason: { color: theme.colors.statusConnecting, fontSize: 11, lineHeight: 16, marginTop: 3 },
  dispatchBlockReason: { color: theme.colors.textMuted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
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
  resultsCard: { paddingVertical: 4 },
  resultRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  resultIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  resultIconSuccess: { borderColor: theme.colors.statusConnected + '66', backgroundColor: theme.colors.statusConnectedGlow },
  resultIconWarning: { borderColor: theme.colors.statusConnecting + '66', backgroundColor: theme.colors.statusConnectingGlow },
  resultIconDanger: { borderColor: theme.colors.statusError + '66', backgroundColor: theme.colors.statusErrorGlow },
  resultMain: { flex: 1, minWidth: 0 },
  resultTitle: { color: theme.colors.textValue, fontSize: 12, fontWeight: '700' },
  resultDetail: { marginTop: 4, color: theme.colors.textSecondary, fontFamily: 'SpaceMono', fontSize: 9, lineHeight: 14 },
  resultError: { color: theme.colors.statusError, fontSize: 11, lineHeight: 17 },
});
