import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../constants/theme';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  MAPPING_DISPOSITION,
  finishMapping,
  generateAutonomyRequestId,
  generateMappingMapId,
  isValidMapId,
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
  const [setupOpen, setSetupOpen] = useState(false);
  const [mapId, setMapId] = useState(() => generateMappingMapId());
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
    const normalizedMapId = mapId.trim();
    if (!isValidMapId(normalizedMapId)) return;
    if (!transport || !useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'set_mode',
      desiredMode: AUTONOMY_MODE.MAPPING,
    })) return;
    // 名称在启动前由用户确认，并一直保留到 FinishMapping(SAVE)。开始服务
    // 仍只接收会话 ID，避免把尚不存在的地图误报为已有资产身份。
    useAutonomyRuntimeStore.getState().setMappingTargetId(normalizedMapId);
    setSetupOpen(false);
    try {
      const response = await setAutonomyMode(transport, {
        desiredMode: AUTONOMY_MODE.MAPPING,
        // 每次开始建图都创建独立会话，防止上一次未完成会话污染新地图。
        // mapId 仅在 FinishMapping(SAVE) 时提交；开始建图时携带 map_id 会被
        // Mission 按合同拒绝，因为此时地图资产尚未生成、也没有可校验的身份。
        mappingSessionId: generateAutonomyRequestId(`mapping-${normalizedMapId}`),
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
  }, [mapId, reportRejected, t, transport]);

  const requestFinishMapping = useCallback(async (disposition: MappingDisposition) => {
    const targetMapId = mapId.trim();
    if (disposition === MAPPING_DISPOSITION.SAVE && !isValidMapId(targetMapId)) return;
    if (!transport || !useAutonomyRuntimeStore.getState().beginCommand({
      kind: 'finish_mapping',
    })) return;
    setSetupOpen(false);
    try {
      const response = await finishMapping(transport, {
        disposition,
        mapId: disposition === MAPPING_DISPOSITION.SAVE ? targetMapId : undefined,
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
  }, [mapId, reportRejected, t, transport]);

  const confirmCommand = useCallback(() => {
    if (mappingFinishable) {
      // 结束时再次展示名称：即使 APP 在建图中途重连、内存候选名丢失，
      // 操作者仍能明确命名后保存，绝不能误用 SLAM 的 external_map_id。
      setMapId(mappingTargetId || generateMappingMapId());
      setSetupOpen(true);
      return;
    }

    // Android 的 Alert 不支持可靠文本输入，使用横屏友好的自定义对话框。
    setMapId(generateMappingMapId());
    setSetupOpen(true);
  }, [mappingFinishable, mappingTargetId]);

  const synchronized = runtime !== null && !runtimeStale;
  const runtimeFault = phase === AUTONOMY_PHASE.ERROR || phase === AUTONOMY_PHASE.CONFLICT;
  const connected = connectionStatus === 'connected' && Boolean(transport) && !url.startsWith('demo://');
  const canStart = synchronized && !mappingActive && !transitioning && !runtimeFault && !missionActive;
  const canFinish = synchronized && mappingFinishable;
  const disabled = !connected || pendingCommand !== null || (!canStart && !canFinish);
  const mapIdValid = isValidMapId(mapId.trim());

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
    <>
      <View style={[styles.controlBlock, compact && styles.compactControlBlock]}>
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
        {!compact && mappingTargetId ? (
          <Text style={styles.mapNameText} numberOfLines={1}>
            {t('mapping.activeMap', { map: mappingTargetId })}
          </Text>
        ) : null}
      </View>

      <Modal
        visible={setupOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSetupOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSetupOpen(false)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>
              {t(mappingFinishable ? 'mapping.stopConfirmTitle' : 'mapping.confirmTitle')}
            </Text>
            <Text style={styles.dialogHint}>
              {t(mappingFinishable ? 'mapping.stopConfirmMessage' : 'mapping.confirmMessage')}
            </Text>
            <Text style={styles.fieldLabel}>{t('mapping.mapName')}</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={64}
              selectTextOnFocus
              returnKeyType="done"
              value={mapId}
              onChangeText={setMapId}
              placeholder="factory-a-floor-1"
              placeholderTextColor={theme.colors.textMuted}
              style={[styles.input, !mapIdValid && styles.inputInvalid]}
            />
            {!mapIdValid ? (
              <Text style={styles.errorText}>{t('mapping.mapNameInvalid')}</Text>
            ) : null}
            <Text style={styles.nameHint}>{t('mapping.mapNameHint')}</Text>
            <View style={styles.dialogActions}>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={() => setSetupOpen(false)}
              >
                <Text style={styles.secondaryButtonText}>{t('mapping.cancel')}</Text>
              </TouchableOpacity>
              {mappingFinishable ? (
                <>
                  <TouchableOpacity
                    style={styles.discardButton}
                    onPress={() => void requestFinishMapping(MAPPING_DISPOSITION.DISCARD)}
                  >
                    <Text style={styles.discardButtonText}>{t('mapping.discard')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={!mapIdValid || !canFinish}
                    style={[
                      styles.primaryButton,
                      (!mapIdValid || !canFinish) && styles.disabled,
                    ]}
                    onPress={() => void requestFinishMapping(MAPPING_DISPOSITION.SAVE)}
                  >
                    <Text style={styles.primaryButtonText}>{t('mapping.stop')}</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  disabled={!mapIdValid || !canStart}
                  style={[
                    styles.primaryButton,
                    (!mapIdValid || !canStart) && styles.disabled,
                  ]}
                  onPress={() => void requestMappingMode()}
                >
                  <Text style={styles.primaryButtonText}>{t('mapping.start')}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  controlBlock: { flex: 1, minWidth: 120, gap: 4 },
  compactControlBlock: { flex: 0, minWidth: 40 },
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
  mapNameText: {
    color: theme.colors.textMuted,
    fontSize: 9,
    paddingHorizontal: 3,
  },
  modalOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
    backgroundColor: '#00000088',
  },
  dialog: {
    width: 430,
    maxWidth: '94%',
    maxHeight: '94%',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.bgElevated,
  },
  dialogTitle: {
    color: theme.colors.textPrimary,
    fontSize: 19,
    fontWeight: '700',
  },
  dialogHint: {
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 8,
  },
  fieldLabel: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 15,
    marginBottom: 6,
  },
  input: {
    minHeight: 46,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    color: theme.colors.textValue,
    backgroundColor: theme.colors.bgInset,
    fontFamily: 'SpaceMono',
    fontSize: 12,
  },
  inputInvalid: { borderColor: theme.colors.statusError },
  errorText: { color: theme.colors.statusError, fontSize: 10, marginTop: 5 },
  nameHint: { color: theme.colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 7 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  secondaryButton: {
    minHeight: 42,
    minWidth: 90,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
  },
  secondaryButtonText: { color: theme.colors.textSecondary, fontWeight: '700' },
  discardButton: {
    minHeight: 42,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.statusError + '88',
    backgroundColor: theme.colors.statusErrorGlow,
  },
  discardButtonText: { color: theme.colors.statusError, fontWeight: '700' },
  primaryButton: {
    minHeight: 42,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: theme.colors.accentPrimary,
  },
  primaryButtonText: { color: '#061014', fontWeight: '800' },
});
