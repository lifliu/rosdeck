import { Ionicons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../constants/theme';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  setAutonomyMode,
} from '../lib/autonomy-runtime';
import { useTranslation } from '../lib/i18n';
import { ACTIVE_MISSION_STATES, MISSION_STATE } from '../lib/mission/types';
import { useAutonomyRuntimeStore } from '../stores/useAutonomyRuntimeStore';
import { useMissionStore } from '../stores/useMissionStore';
import { useRosStore } from '../stores/useRosStore';

function phaseIsTransitioning(phase: number): boolean {
  return phase === AUTONOMY_PHASE.STARTING ||
    phase === AUTONOMY_PHASE.SWITCHING ||
    phase === AUTONOMY_PHASE.STOPPING;
}

export function NavigationControl({ compact = false }: { compact?: boolean }) {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const runtime = useAutonomyRuntimeStore((state) => state.status);
  const runtimeStale = useAutonomyRuntimeStore((state) => state.stale);
  const pendingCommand = useAutonomyRuntimeStore((state) => state.pendingCommand);
  const missionState = useMissionStore((state) => state.status?.state ?? MISSION_STATE.NONE);
  const { t } = useTranslation();

  const phase = runtime?.phase ?? AUTONOMY_PHASE.IDLE;
  const synchronized = runtime !== null && !runtimeStale;
  const transitioning = phaseIsTransitioning(phase);
  const runtimeFault = phase === AUTONOMY_PHASE.ERROR || phase === AUTONOMY_PHASE.CONFLICT;
  const navigationReady = runtime?.mode === AUTONOMY_MODE.SINGLE_POINT_READY &&
    runtime.ready === true && phase === AUTONOMY_PHASE.READY;
  const navigationStarting = runtime?.desired_mode === AUTONOMY_MODE.SINGLE_POINT_READY &&
    transitioning;
  const missionActive = ACTIVE_MISSION_STATES.includes(missionState);
  const protectedMode = runtime?.mode === AUTONOMY_MODE.MAPPING ||
    runtime?.mode === AUTONOMY_MODE.ROUTE_RECORDING;

  const requestNavigationMode = useCallback(async () => {
    if (!transport || !useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'set_mode',
      desiredMode: AUTONOMY_MODE.SINGLE_POINT_READY,
    })) return;
    try {
      const response = await setAutonomyMode(transport, {
        desiredMode: AUTONOMY_MODE.SINGLE_POINT_READY,
      });
      useAutonomyRuntimeStore.getState().completeCommand(response);
      if (!response.accepted) {
        Alert.alert(
          t('navigation.failedTitle'),
          t('navigation.error', { message: response.reason_text || 'unknown' }),
        );
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      useAutonomyRuntimeStore.getState().failCommand(message);
      Alert.alert(
        t('navigation.failedTitle'),
        t('navigation.error', { message }),
      );
    }
  }, [t, transport]);

  const confirmNavigation = useCallback(() => {
    Alert.alert(
      t('navigation.confirmTitle'),
      t('navigation.confirmMessage'),
      [
        { text: t('navigation.cancel'), style: 'cancel' },
        { text: t('navigation.start'), onPress: () => void requestNavigationMode() },
      ],
    );
  }, [requestNavigationMode, t]);

  const connected = connectionStatus === 'connected' && Boolean(transport) && !url.startsWith('demo://');
  const canEnsureNavigation = synchronized && !transitioning && !runtimeFault &&
    !navigationReady && !missionActive && !protectedMode;
  const disabled = !connected || pendingCommand !== null || !canEnsureNavigation;
  const navigationCommandPending = pendingCommand?.kind === 'set_mode' &&
    pendingCommand.desiredMode === AUTONOMY_MODE.SINGLE_POINT_READY;

  // “巡检运行中”只由 MissionStatus 的三个非终态派生，不能用运行时模式替代任务事实。
  const labelKey = missionActive
    ? 'navigation.inspectionRunningButton'
    : navigationCommandPending || navigationStarting
      ? 'navigation.startingButton'
      : navigationReady
        ? 'navigation.readyButton'
        : runtimeFault
          ? 'navigation.unavailableButton'
          : !synchronized
            ? 'navigation.checkingButton'
            : protectedMode
              ? 'navigation.busyButton'
              : 'navigation.button';

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t(labelKey)}
      style={[
        styles.button,
        navigationReady && styles.readyButton,
        compact && styles.compactButton,
        disabled && styles.disabled,
      ]}
      disabled={disabled}
      onPress={confirmNavigation}
      activeOpacity={0.75}
    >
      <Ionicons
        name={navigationCommandPending || navigationStarting
          ? 'hourglass-outline'
          : navigationReady
            ? 'checkmark-circle-outline'
            : runtimeFault
              ? 'warning-outline'
              : 'navigate-outline'}
        size={compact ? 20 : 16}
        color={disabled && !navigationReady
          ? theme.colors.textMuted
          : theme.colors.statusConnected}
      />
      {!compact && (
        <Text style={[styles.text, disabled && !navigationReady && styles.disabledText]}>
          {t(labelKey)}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.statusConnected + '66',
    backgroundColor: theme.colors.statusConnected + '11',
  },
  compactButton: {
    width: 40,
    height: 40,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  readyButton: {
    borderColor: theme.colors.statusConnected + '88',
    backgroundColor: theme.colors.statusConnected + '16',
  },
  disabled: {
    opacity: 0.58,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.bgSurface,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.statusConnected,
  },
  disabledText: {
    color: theme.colors.textMuted,
  },
});
