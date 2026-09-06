import { Ionicons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../constants/theme';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  MAPPING_DISPOSITION,
  finishMapping,
  generateAutonomyRequestId,
  generateMappingMapId,
  setAutonomyMode,
  type MappingDisposition,
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

export function MappingControl({ compact = false }: { compact?: boolean }) {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const runtime = useAutonomyRuntimeStore((state) => state.status);
  const runtimeStale = useAutonomyRuntimeStore((state) => state.stale);
  const pendingCommand = useAutonomyRuntimeStore((state) => state.pendingCommand);
  const mappingTargetId = useAutonomyRuntimeStore((state) => state.mappingTargetId);
  const missionState = useMissionStore((state) => state.status?.state ?? MISSION_STATE.NONE);
  const { t } = useTranslation();

  const phase = runtime?.phase ?? AUTONOMY_PHASE.IDLE;
  const transitioning = phaseIsTransitioning(phase);
  const mappingRequested = runtime?.desired_mode === AUTONOMY_MODE.MAPPING;
  const mappingActive = runtime?.mode === AUTONOMY_MODE.MAPPING;
  const mappingReady = mappingActive && runtime?.ready === true && phase === AUTONOMY_PHASE.READY;
  const mappingFinishable = mappingReady ||
    (mappingActive && phase === AUTONOMY_PHASE.ERROR);
  const mappingStarting = mappingRequested && transitioning && phase !== AUTONOMY_PHASE.STOPPING;
  const mappingStopping = mappingActive && phase === AUTONOMY_PHASE.STOPPING;
  const missionActive = ACTIVE_MISSION_STATES.includes(missionState);

  const reportRejected = useCallback((title: string, reason: string) => {
    Alert.alert(title, t('mapping.error', { message: reason || 'unknown' }));
  }, [t]);

  const requestMappingMode = useCallback(async () => {
    if (!transport || !useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'set_mode',
      desiredMode: AUTONOMY_MODE.MAPPING,
    })) return;
    const mapId = generateMappingMapId();
    useAutonomyRuntimeStore.getState().setMappingTargetId(mapId);
    try {
      const response = await setAutonomyMode(transport, {
        desiredMode: AUTONOMY_MODE.MAPPING,
        // 每次开始建图都创建独立会话，防止上一次未完成会话污染新地图。
        // mapId 仅在 FinishMapping(SAVE) 时提交；开始建图时携带 map_id 会被
        // Mission 按合同拒绝，因为此时地图资产尚未生成、也没有可校验的身份。
        mappingSessionId: generateAutonomyRequestId('mapping-session'),
      });
      useAutonomyRuntimeStore.getState().completeCommand(response);
      if (!response.accepted) {
        useAutonomyRuntimeStore.getState().setMappingTargetId('');
        reportRejected(t('mapping.failedTitle'), response.reason_text);
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      useAutonomyRuntimeStore.getState().failCommand(message);
      useAutonomyRuntimeStore.getState().setMappingTargetId('');
      reportRejected(t('mapping.failedTitle'), message);
    }
  }, [reportRejected, t, transport]);

  const requestFinishMapping = useCallback(async (disposition: MappingDisposition) => {
    // 地图名称是在 SAVE 时才冻结的资产属性。APP/WebSocket 中途重连会清掉
    // 本地候选名，此时生成新名称即可继续保存，不能把一个健康建图会话卡死。
    const targetMapId = mappingTargetId || runtime?.map_id || generateMappingMapId();
    if (!transport || !useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'finish_mapping',
    })) return;
    try {
      const response = await finishMapping(transport, {
        disposition,
        mapId: targetMapId,
        makeCurrent: disposition === MAPPING_DISPOSITION.SAVE,
      });
      useAutonomyRuntimeStore.getState().completeCommand(response);
      if (!response.accepted) {
        reportRejected(t('mapping.stopFailedTitle'), response.reason_text);
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      useAutonomyRuntimeStore.getState().failCommand(message);
      reportRejected(t('mapping.stopFailedTitle'), message);
    }
  }, [mappingTargetId, reportRejected, runtime?.map_id, t, transport]);

  const confirmCommand = useCallback(() => {
    if (mappingFinishable) {
      Alert.alert(
        t('mapping.stopConfirmTitle'),
        t('mapping.stopConfirmMessage'),
        [
          { text: t('mapping.cancel'), style: 'cancel' },
          {
            text: t('mapping.discard'),
            style: 'destructive',
            onPress: () => void requestFinishMapping(MAPPING_DISPOSITION.DISCARD),
          },
          {
            text: t('mapping.stop'),
            onPress: () => void requestFinishMapping(MAPPING_DISPOSITION.SAVE),
          },
        ],
      );
      return;
    }

    Alert.alert(
      t('mapping.confirmTitle'),
      t('mapping.confirmMessage'),
      [
        { text: t('mapping.cancel'), style: 'cancel' },
        { text: t('mapping.start'), onPress: () => void requestMappingMode() },
      ],
    );
  }, [mappingFinishable, requestFinishMapping, requestMappingMode, t]);

  const synchronized = runtime !== null && !runtimeStale;
  const runtimeFault = phase === AUTONOMY_PHASE.ERROR || phase === AUTONOMY_PHASE.CONFLICT;
  const connected = connectionStatus === 'connected' && Boolean(transport) && !url.startsWith('demo://');
  const canStart = synchronized && !mappingActive && !transitioning && !runtimeFault && !missionActive;
  const canFinish = synchronized && mappingFinishable;
  const disabled = !connected || pendingCommand !== null || (!canStart && !canFinish);

  const mappingCommandPending = pendingCommand?.kind === 'finish_mapping' ||
    (pendingCommand?.kind === 'set_mode' && pendingCommand.desiredMode === AUTONOMY_MODE.MAPPING);
  const labelKey = pendingCommand?.kind === 'finish_mapping' || mappingStopping
    ? 'mapping.stoppingButton'
    : mappingCommandPending || mappingStarting
      ? 'mapping.startingButton'
      : mappingFinishable
        ? 'mapping.stopButton'
        : runtimeFault
          ? 'mapping.unavailableButton'
          : !synchronized
            ? 'mapping.checkingButton'
            : 'mapping.button';

  const activeStyle = mappingFinishable || mappingStarting || mappingStopping;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t(labelKey)}
      style={[
        styles.button,
        mappingFinishable && styles.stopButton,
        compact && styles.compactButton,
        disabled && styles.disabled,
      ]}
      disabled={disabled}
      onPress={confirmCommand}
      activeOpacity={0.75}
    >
      <Ionicons
        name={mappingFinishable
          ? 'stop-circle-outline'
          : activeStyle
            ? 'hourglass-outline'
            : 'cube-outline'}
        size={compact ? 20 : 16}
        color={disabled
          ? theme.colors.textMuted
          : mappingFinishable
            ? theme.colors.statusError
            : theme.colors.accentPrimary}
      />
      {!compact && (
        <Text style={[styles.text, mappingFinishable && styles.stopText]}>
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
    borderColor: theme.colors.accentPrimary + '66',
    backgroundColor: theme.colors.accentPrimary + '11',
  },
  compactButton: {
    width: 40,
    height: 40,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  stopButton: {
    borderColor: theme.colors.statusError + '88',
    backgroundColor: theme.colors.statusErrorGlow,
  },
  disabled: {
    opacity: 0.45,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.bgSurface,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.accentPrimary,
  },
  stopText: {
    color: theme.colors.statusError,
  },
});
