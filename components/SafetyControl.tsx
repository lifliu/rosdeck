import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation } from '../lib/i18n';
import {
  ARBITER_STATUS_STALE_MS,
  ARM_SUPERVISOR_SERVICE,
  CMD_VEL_ARBITER_STATUS_TOPIC,
  SAFETY_STATUS_MESSAGE_TYPE,
  SAFETY_SUPERVISOR_STATUS_TOPIC,
  SUPERVISOR_STATUS_STALE_MS,
  callSafetyTrigger,
  parseArbiterSafetyStatus,
  parseSupervisorSafetyStatus,
  runTwoStageSafetyReset,
  safetyResetIsAuthorized,
  safetyResetMayStart,
  summarizeSafetyStatus,
  type ArbiterSafetyStatus,
  type SafetyResetAccess,
  type SupervisorSafetyStatus,
} from '../lib/safety-control';
import { useControlAuthorityStore } from '../stores/useControlAuthorityStore';
import { useRosStore } from '../stores/useRosStore';

interface SupervisorSample {
  value: SupervisorSafetyStatus;
  receivedAt: number;
}

interface ArbiterSample {
  value: ArbiterSafetyStatus;
  receivedAt: number;
}

function confirmSafetyStep(
  title: string,
  message: string,
  cancelLabel: string,
  confirmLabel: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => finish(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}

export function SafetyControl({ compact = false }: { compact?: boolean }) {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const authorityStatus = useControlAuthorityStore((state) => state.status);
  const authorityOwnerId = useControlAuthorityStore((state) => state.ownerId);
  const { t } = useTranslation();
  const [supervisorSample, setSupervisorSample] = useState<SupervisorSample | null>(null);
  const [arbiterSample, setArbiterSample] = useState<ArbiterSample | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const supervisorSampleRef = useRef<SupervisorSample | null>(null);
  const arbiterSampleRef = useRef<ArbiterSample | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    supervisorSampleRef.current = null;
    arbiterSampleRef.current = null;
    setSupervisorSample(null);
    setArbiterSample(null);
    setClock(Date.now());
    if (connectionStatus !== 'connected' || !transport || url.startsWith('demo://')) return;
    let cancelled = false;
    const stillCurrent = () => {
      const ros = useRosStore.getState();
      return !cancelled && mountedRef.current && ros.connection.status === 'connected' &&
        ros.connection.url === url && ros.transport === transport;
    };

    const supervisorSubscription = transport.subscribe(
      SAFETY_SUPERVISOR_STATUS_TOPIC,
      SAFETY_STATUS_MESSAGE_TYPE,
      (message) => {
        if (!stillCurrent()) return;
        const value = parseSupervisorSafetyStatus(message);
        if (value) {
          const sample = { value, receivedAt: Date.now() };
          supervisorSampleRef.current = sample;
          setSupervisorSample(sample);
        } else {
          supervisorSampleRef.current = null;
          setSupervisorSample(null);
        }
      },
    );
    const arbiterSubscription = transport.subscribe(
      CMD_VEL_ARBITER_STATUS_TOPIC,
      SAFETY_STATUS_MESSAGE_TYPE,
      (message) => {
        if (!stillCurrent()) return;
        const value = parseArbiterSafetyStatus(message);
        if (value) {
          const previous = arbiterSampleRef.current;
          if (previous && value.statusSeq <= previous.value.statusSeq) {
            arbiterSampleRef.current = null;
            setArbiterSample(null);
            return;
          }
          const sample = { value, receivedAt: Date.now() };
          arbiterSampleRef.current = sample;
          setArbiterSample(sample);
        } else {
          arbiterSampleRef.current = null;
          setArbiterSample(null);
        }
      },
    );
    const staleTimer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(staleTimer);
      supervisorSubscription.unsubscribe();
      arbiterSubscription.unsubscribe();
    };
  }, [connectionStatus, transport, url]);

  const supervisorStale = !supervisorSample ||
    clock - supervisorSample.receivedAt > SUPERVISOR_STATUS_STALE_MS;
  const arbiterStale = !arbiterSample ||
    clock - arbiterSample.receivedAt > ARBITER_STATUS_STALE_MS;
  const summary = summarizeSafetyStatus(
    supervisorSample?.value ?? null,
    arbiterSample?.value ?? null,
    supervisorStale,
    arbiterStale,
  );
  const access: SafetyResetAccess = {
    connectionStatus,
    url,
    transport,
    authorityStatus,
    authorityOwnerId,
  };
  const authorized = safetyResetIsAuthorized(access);
  const resetStateReady = safetyResetMayStart(
    supervisorSample?.value ?? null,
    arbiterSample?.value ?? null,
    supervisorStale,
    arbiterStale,
  );
  const canReset = authorized && resetStateReady && !pending;

  const supervisorLabel = !supervisorSample
    ? t('safety.supervisorUnknown')
    : supervisorStale
      ? t('safety.supervisorStale')
      : supervisorSample.value.state === 'latched'
        ? t('safety.supervisorLatched')
        : t('safety.supervisorArmed');
  const arbiterLabel = !arbiterSample
    ? t('safety.arbiterUnknown')
    : arbiterStale
      ? t('safety.arbiterStale')
      : arbiterSample.value.estopMonitorFault
        ? t('safety.arbiterFault')
        : arbiterSample.value.estop
          ? t('safety.arbiterEstop')
          : t('safety.arbiterReady');
  const statusLabel = `${supervisorLabel} · ${arbiterLabel}`;

  const reset = useCallback(async () => {
    if (pendingRef.current) return;
    const rosAtStart = useRosStore.getState();
    const authorityAtStart = useControlAuthorityStore.getState();
    const startAccess: SafetyResetAccess = {
      connectionStatus: rosAtStart.connection.status,
      url: rosAtStart.connection.url,
      transport: rosAtStart.transport,
      authorityStatus: authorityAtStart.status,
      authorityOwnerId: authorityAtStart.ownerId,
    };
    if (!safetyResetIsAuthorized(startAccess) || !rosAtStart.transport) return;

    const source = { url: rosAtStart.connection.url, transport: rosAtStart.transport };
    let supervisorArmAccepted = false;
    const isAuthorized = () => {
      if (!mountedRef.current) return false;
      const ros = useRosStore.getState();
      const authority = useControlAuthorityStore.getState();
      const liveSupervisor = supervisorSampleRef.current;
      const liveArbiter = arbiterSampleRef.current;
      const now = Date.now();
      const liveSupervisorStale = !liveSupervisor ||
        now - liveSupervisor.receivedAt > SUPERVISOR_STATUS_STALE_MS;
      const liveArbiterStale = !liveArbiter ||
        now - liveArbiter.receivedAt > ARBITER_STATUS_STALE_MS;
      const liveSummary = summarizeSafetyStatus(
        liveSupervisor?.value ?? null,
        liveArbiter?.value ?? null,
        liveSupervisorStale,
        liveArbiterStale,
      );
      const safetyStateReady = supervisorArmAccepted
        ? liveSummary.telemetryReady && liveArbiter?.value.estop === true
        : safetyResetMayStart(
          liveSupervisor?.value ?? null,
          liveArbiter?.value ?? null,
          liveSupervisorStale,
          liveArbiterStale,
        );
      return safetyStateReady &&
        safetyResetIsAuthorized({
          connectionStatus: ros.connection.status,
          url: ros.connection.url,
          transport: ros.transport,
          authorityStatus: authority.status,
          authorityOwnerId: authority.ownerId,
        }, source);
    };
    if (!isAuthorized()) return;

    pendingRef.current = true;
    setPending(true);
    const outcome = await runTwoStageSafetyReset({
      isAuthorized,
      confirmArmSupervisor: () => confirmSafetyStep(
        t('safety.armConfirmTitle'),
        t('safety.armConfirmMessage'),
        t('safety.cancel'),
        t('safety.armButton'),
      ),
      confirmResetEstop: (armMessage) => confirmSafetyStep(
        t('safety.resetConfirmTitle'),
        t('safety.resetConfirmMessage', { message: armMessage }),
        t('safety.cancel'),
        t('safety.resetButton'),
      ),
      callTrigger: async (service) => {
        const response = await callSafetyTrigger(source.transport, service);
        if (service === ARM_SUPERVISOR_SERVICE && response?.success === true) {
          supervisorArmAccepted = true;
        }
        return response;
      },
    });
    pendingRef.current = false;
    if (!mountedRef.current) return;
    setPending(false);

    if (outcome.kind === 'completed') {
      Alert.alert(t('safety.successTitle'), t('safety.successMessage'));
    } else if (outcome.kind === 'failed') {
      Alert.alert(t('safety.failedTitle'), t('safety.error', { message: outcome.message }));
    } else if (outcome.kind === 'blocked') {
      Alert.alert(t('safety.failedTitle'), t('safety.blocked'));
    } else if (outcome.kind === 'cancelled' && outcome.stage === 'reset_estop') {
      Alert.alert(t('safety.incompleteTitle'), t('safety.incompleteMessage'));
    }
  }, [t]);

  if (url.startsWith('demo://')) return null;

  const color = summary.level === 'safe'
    ? theme.colors.statusConnected
    : summary.level === 'unknown'
      ? theme.colors.textMuted
      : summary.level === 'fault'
        ? theme.colors.statusConnecting
        : theme.colors.statusError;

  return (
    <View style={styles.container}>
      <View
        accessible
        accessibilityLabel={statusLabel}
        style={[
          styles.status,
          compact && styles.compactStatus,
          { borderColor: color + '66', backgroundColor: color + '11' },
        ]}
      >
        <Ionicons
          name={summary.level === 'safe' ? 'shield-checkmark-outline' : 'warning-outline'}
          size={compact ? 20 : 16}
          color={color}
        />
        {!compact && <Text style={[styles.statusText, { color }]}>{statusLabel}</Text>}
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t('safety.resetButton')}
        disabled={!canReset}
        onPress={reset}
        activeOpacity={0.75}
        style={[
          styles.resetButton,
          compact && styles.compactButton,
          !canReset && styles.disabled,
        ]}
      >
        <Ionicons
          name={pending ? 'hourglass-outline' : 'refresh-circle-outline'}
          size={compact ? 20 : 16}
          color={canReset ? theme.colors.statusError : theme.colors.textMuted}
        />
        {!compact && (
          <Text style={[styles.resetText, !canReset && styles.disabledText]}>
            {t(pending ? 'safety.resetting' : 'safety.resetButton')}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  compactStatus: {
    width: 40,
    height: 40,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  statusText: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: '600',
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.statusError + '88',
    backgroundColor: theme.colors.statusErrorGlow,
  },
  compactButton: {
    width: 40,
    height: 40,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  disabled: {
    opacity: 0.45,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.bgSurface,
  },
  resetText: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: '600',
    color: theme.colors.statusError,
  },
  disabledText: {
    color: theme.colors.textMuted,
  },
});
