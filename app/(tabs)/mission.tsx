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
import { theme } from '../../constants/theme';
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
  generateRequestId,
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
  const { t } = useTranslation();

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
      const requestId =
        pending && pending.routeId === routeId ? pending.requestId : generateRequestId();
      store.setPendingDispatch({ requestId, routeId });
      store.setDispatching(true);
      store.setError(null);
      try {
        const response = await dispatchMission(transport!, { routeId, requestId });
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
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Text style={styles.title}>{t('mission.title')}</Text>

      {!connected ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>{t('mission.notConnected')}</Text>
          <Text style={styles.emptyHint}>{t('mission.notConnectedHint')}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          {lastError ? (
            <TouchableOpacity
              style={styles.errorBanner}
              activeOpacity={0.8}
              onPress={() => useMissionStore.getState().setError(null)}
            >
              <Text style={styles.errorText}>{lastError}</Text>
            </TouchableOpacity>
          ) : null}

          {/* ---- route picker ---- */}
          <Text style={styles.section}>{t('mission.routes')}</Text>
          {!routesLoaded ? (
            <Text style={styles.muted}>{t('mission.routesLoading')}</Text>
          ) : routes.length === 0 ? (
            <Text style={styles.muted}>{t('mission.noRoutes')}</Text>
          ) : (
            routes.map((route) => {
              const selected = route.routeId === selectedRouteId;
              return (
                <TouchableOpacity
                  key={route.routeId}
                  style={[styles.routeRow, selected && styles.routeRowSelected]}
                  activeOpacity={0.75}
                  onPress={() =>
                    useMissionStore
                      .getState()
                      .selectRoute(selected ? null : route.routeId)
                  }
                >
                  <View style={styles.routeMain}>
                    <Text style={styles.routeId}>{route.routeId}</Text>
                    <Text style={styles.muted}>
                      {route.mapId
                        ? t('mission.routeMap', { map: route.mapId })
                        : t('mission.routeUnbound')}
                    </Text>
                  </View>
                  {selected && (
                    <Ionicons
                      name="checkmark"
                      size={18}
                      color={theme.colors.accentPrimary}
                    />
                  )}
                </TouchableOpacity>
              );
            })
          )}
          <TouchableOpacity
            style={[styles.dispatchButton, (!selectedRouteId || dispatching) && styles.disabled]}
            disabled={!selectedRouteId || dispatching}
            activeOpacity={0.75}
            onPress={onDispatchPress}
          >
            <Ionicons
              name={dispatching ? 'hourglass-outline' : 'send-outline'}
              size={16}
              color={theme.colors.bgBase}
            />
            <Text style={styles.dispatchText}>
              {dispatching ? t('mission.dispatching') : t('mission.dispatch')}
            </Text>
          </TouchableOpacity>

          {/* ---- active mission card ---- */}
          <Text style={styles.section}>{t('mission.missionCard')}</Text>
          {missionState === MISSION_STATE.NONE ? (
            <Text style={styles.muted}>{t('mission.noActiveMission')}</Text>
          ) : (
            <View style={styles.card}>
              <View style={styles.cardRow}>
                <View
                  style={[styles.badge, { borderColor: stateColor(missionState) + '88' }]}
                >
                  <Text style={[styles.badgeText, { color: stateColor(missionState) }]}>
                    {t(STATE_LABELS[missionState] ?? 'mission.state.none')}
                  </Text>
                </View>
                <Text style={styles.muted} numberOfLines={1}>
                  {mission?.route_id}
                </Text>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${progress * 100}%`, backgroundColor: stateColor(missionState) },
                  ]}
                />
              </View>
              <View style={styles.cardRow}>
                <Text style={styles.muted}>{Math.round(progress * 100)}%</Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {mission?.mission_id}
                </Text>
              </View>
              {mission?.reason_text ? (
                <Text style={styles.cardReason}>{mission.reason_text}</Text>
              ) : null}
              {missionActive ? (
                <View style={styles.controlRow}>
                  <TouchableOpacity
                    style={[styles.controlButton, controlling && styles.disabled]}
                    disabled={controlling || missionState === MISSION_STATE.PAUSED}
                    activeOpacity={0.75}
                    onPress={() => void runControl((mid) => pauseMission(transport!, mid))}
                  >
                    <Ionicons name="pause-outline" size={15} color={theme.colors.textValue} />
                    <Text style={styles.controlText}>{t('mission.pause')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.controlButton, controlling && styles.disabled]}
                    disabled={controlling || missionState !== MISSION_STATE.PAUSED}
                    activeOpacity={0.75}
                    onPress={() => void runControl((mid) => resumeMission(transport!, mid))}
                  >
                    <Ionicons name="play-outline" size={15} color={theme.colors.textValue} />
                    <Text style={styles.controlText}>{t('mission.resume')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.controlButton, styles.controlCancel]}
                    disabled={controlling}
                    activeOpacity={0.75}
                    onPress={onCancelPress}
                  >
                    <Ionicons name="close-outline" size={15} color={theme.colors.statusError} />
                    <Text style={[styles.controlText, { color: theme.colors.statusError }]}>
                      {t('mission.cancel')}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          )}

          {/* ---- robot state strip ---- */}
          <Text style={styles.section}>{t('mission.robot')}</Text>
          <View style={styles.card}>
            <View style={styles.cardRow}>
              <Text style={styles.stripLabel}>
                {t(LOC_LABELS[robotStrip?.localization_state ?? LOCALIZATION_STATE.UNKNOWN] ?? 'mission.loc.unknown')}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {robotStrip?.map_id || t('mission.none')}
              </Text>
              <Text style={styles.muted}>
                {Number.isFinite(robotStrip?.battery_percentage ?? NaN)
                  ? `${Math.round(robotStrip!.battery_percentage)}%`
                  : t('mission.none')}
              </Text>
              {robotStrip?.estop_latched ? (
                <Text style={styles.estopText}>{t('mission.estop')}</Text>
              ) : null}
            </View>
          </View>

          {/* ---- event log ---- */}
          <Text style={styles.section}>{t('mission.events')}</Text>
          {events.length === 0 ? (
            <Text style={styles.muted}>{t('mission.noEvents')}</Text>
          ) : (
            events.map((event) => (
              <View key={`${event.mission_id}-${event.sequence}`} style={styles.eventRow}>
                <Text style={styles.eventLabel}>
                  {t(EVENT_LABELS[event.event] ?? 'mission.event.dispatched')}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {event.reason_text || ''}
                </Text>
                <Text style={styles.eventSeq}>#{event.sequence}</Text>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.colors.bgBase,
  },
  title: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: theme.colors.textMuted,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    textTransform: 'uppercase',
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  section: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    color: theme.colors.textMuted,
    marginTop: 16,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  muted: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontFamily: 'SpaceMono',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 24,
  },
  emptyTitle: {
    fontFamily: 'SpaceMono',
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.textSecondary,
  },
  emptyHint: {
    fontSize: 13,
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
  errorBanner: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.statusErrorGlow,
    borderColor: theme.colors.statusError + '66',
    borderWidth: 1,
  },
  errorText: {
    color: theme.colors.statusError,
    fontSize: 12,
    fontFamily: 'SpaceMono',
  },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    backgroundColor: theme.colors.bgSurface,
  },
  routeRowSelected: {
    borderColor: theme.colors.accentPrimary + '88',
    backgroundColor: theme.colors.accentPrimaryMuted,
  },
  routeMain: {
    flex: 1,
    gap: 2,
  },
  routeId: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textValue,
  },
  dispatchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 42,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.accentPrimary,
    marginTop: 4,
  },
  disabled: {
    opacity: 0.45,
  },
  dispatchText: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.bgBase,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    backgroundColor: theme.colors.bgSurface,
    padding: 12,
    gap: 8,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.bgInset,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  cardReason: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  controlRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  controlButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.bgInset,
  },
  controlText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textValue,
    textTransform: 'uppercase',
  },
  controlCancel: {
    borderColor: theme.colors.statusError + '55',
  },
  stripLabel: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.textValue,
    textTransform: 'uppercase',
  },
  estopText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.statusError,
    textTransform: 'uppercase',
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
  },
  eventLabel: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.textValue,
    textTransform: 'uppercase',
    width: 92,
  },
  eventSeq: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: theme.colors.textMuted,
  },
});