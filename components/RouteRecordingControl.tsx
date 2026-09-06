import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MapCatalogPicker } from './MapCatalogPicker';
import { theme } from '../constants/theme';
import {
  AUTONOMY_MODE,
  AUTONOMY_PHASE,
  ROUTE_RECORDING_DISPOSITION,
  finishRouteRecording,
  generateRouteId,
  setAutonomyMode,
  type RouteRecordingDisposition,
} from '../lib/autonomy-runtime';
import { useTranslation } from '../lib/i18n';
import {
  isCompleteMapIdentity,
  type MapCatalogEntry,
  type MapIdentity,
} from '../lib/maps';
import { ACTIVE_MISSION_STATES, MISSION_STATE } from '../lib/mission/types';
import { ACTIVE_NAVIGATION_STATES } from '../lib/navigation';
import { useAutonomyRuntimeStore } from '../stores/useAutonomyRuntimeStore';
import { useMissionStore } from '../stores/useMissionStore';
import { useNavigationStore } from '../stores/useNavigationStore';
import { useRosStore } from '../stores/useRosStore';

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function phaseIsTransitioning(phase: number): boolean {
  return phase === AUTONOMY_PHASE.STARTING ||
    phase === AUTONOMY_PHASE.SWITCHING ||
    phase === AUTONOMY_PHASE.STOPPING;
}

/**
 * 路线录制只提交 Mission 意图。地图绑定、录制状态和原子落盘均由机器人端
 * 负责，APP 仅根据权威快照展示点数、距离与未保存状态。
 */
export function RouteRecordingControl() {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const runtime = useAutonomyRuntimeStore((state) => state.status);
  const runtimeStale = useAutonomyRuntimeStore((state) => state.stale);
  const pendingCommand = useAutonomyRuntimeStore((state) => state.pendingCommand);
  const recordingOperationId = useAutonomyRuntimeStore(
    (state) => state.routeRecordingOperationId,
  );
  const missionState = useMissionStore((state) => state.status?.state ?? MISSION_STATE.NONE);
  const navigationState = useNavigationStore((state) => state.status?.state ?? 0);
  const navigationStale = useNavigationStore((state) => state.stale);
  const [setupOpen, setSetupOpen] = useState(false);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [selectedMap, setSelectedMap] = useState<MapIdentity | null>(null);
  const [routeId, setRouteId] = useState(() => generateRouteId());
  const { t } = useTranslation();

  const phase = runtime?.phase ?? AUTONOMY_PHASE.IDLE;
  const synchronized = runtime !== null && !runtimeStale;
  const recording = runtime?.mode === AUTONOMY_MODE.ROUTE_RECORDING;
  const recordingReady = recording && runtime?.ready === true &&
    phase === AUTONOMY_PHASE.READY;
  const recordingFinishable = recording &&
    (recordingReady || phase === AUTONOMY_PHASE.ERROR);
  const recordingStarting = runtime?.desired_mode === AUTONOMY_MODE.ROUTE_RECORDING &&
    phaseIsTransitioning(phase);
  const runtimeFault = phase === AUTONOMY_PHASE.ERROR || phase === AUTONOMY_PHASE.CONFLICT;
  const missionActive = ACTIVE_MISSION_STATES.includes(missionState);
  const navigationActive = !navigationStale && ACTIVE_NAVIGATION_STATES.includes(navigationState);
  const connected = connectionStatus === 'connected' && Boolean(transport) &&
    !url.startsWith('demo://');
  const currentMapIdentity = useMemo<MapIdentity | null>(() => {
    const candidate = runtime ? {
      mapId: runtime.map_id,
      mapVersion: runtime.map_version,
      mapChecksum: runtime.map_checksum,
    } : null;
    return isCompleteMapIdentity(candidate) ? candidate : null;
  }, [runtime?.map_checksum, runtime?.map_id, runtime?.map_version]);
  const routeIdValid = ROUTE_ID_PATTERN.test(routeId.trim());
  const canStart = connected && synchronized && !phaseIsTransitioning(phase) &&
    !runtimeFault && !recording && !missionActive && !navigationActive;
  const canFinish = connected && synchronized && recordingFinishable &&
    Boolean(recordingOperationId);
  const commandPending = pendingCommand?.kind === 'finish_route_recording' ||
    (pendingCommand?.kind === 'set_mode' &&
      pendingCommand.desiredMode === AUTONOMY_MODE.ROUTE_RECORDING);

  const mapLabel = useMemo(() => {
    const identity = setupOpen ? selectedMap : currentMapIdentity;
    if (!identity) return t('routeRecording.mapMissing');
    return `${identity.mapId} · v${identity.mapVersion}`;
  }, [currentMapIdentity, selectedMap, setupOpen, t]);

  const openSetup = useCallback(() => {
    // 每次新建录制会话都查询机器人目录。runtime 身份只用于预选，不能跳过
    // 目录刷新，否则 current 指针变化后手机会继续使用旧版本。
    setSelectedMap(null);
    setMapPickerOpen(true);
  }, []);

  const closeSetup = useCallback(() => {
    setSetupOpen(false);
    setSelectedMap(null);
  }, []);

  const selectCatalogMap = useCallback((entry: MapCatalogEntry) => {
    setSelectedMap(entry);
    setMapPickerOpen(false);
    setSetupOpen(true);
  }, []);

  const requestStart = useCallback(async () => {
    const runtimeStore = useAutonomyRuntimeStore.getState();
    const normalizedRouteId = routeId.trim();
    if (!transport || !runtimeStore.status || runtimeStore.stale ||
        !ROUTE_ID_PATTERN.test(normalizedRouteId)) return;
    if (!isCompleteMapIdentity(selectedMap)) {
      Alert.alert(t('routeRecording.failedTitle'), t('routeRecording.mapMissing'));
      return;
    }
    if (!runtimeStore.beginCommand({
      kind: 'set_mode',
      desiredMode: AUTONOMY_MODE.ROUTE_RECORDING,
    })) return;
    setSetupOpen(false);
    try {
      const response = await setAutonomyMode(transport, {
        desiredMode: AUTONOMY_MODE.ROUTE_RECORDING,
        mapId: selectedMap.mapId,
        mapVersion: selectedMap.mapVersion,
        mapChecksum: selectedMap.mapChecksum,
        routeId: normalizedRouteId,
      });
      useAutonomyRuntimeStore.getState().completeCommand(response);
      if (!response.accepted) {
        Alert.alert(
          t('routeRecording.failedTitle'),
          response.reason_text || t('routeRecording.rejected'),
        );
      } else {
        // 已受理结束后预生成下一条路线键；当前界面仍以 runtime.route_id 展示
        // 正在收口的会话，不会把新键误显示为已保存资产。
        setRouteId(generateRouteId());
      }
      setSelectedMap(null);
    } catch (error: any) {
      const message = error?.message || String(error);
      useAutonomyRuntimeStore.getState().failCommand(message);
      Alert.alert(t('routeRecording.failedTitle'), message);
    }
  }, [routeId, selectedMap, t, transport]);

  const requestFinish = useCallback(async (disposition: RouteRecordingDisposition) => {
    const runtimeStore = useAutonomyRuntimeStore.getState();
    if (!transport || !runtimeStore.routeRecordingOperationId ||
        !runtimeStore.beginCommand({ kind: 'finish_route_recording' })) {
      return;
    }
    try {
      const response = await finishRouteRecording(transport, {
        disposition,
        recordingOperationId: runtimeStore.routeRecordingOperationId,
      });
      useAutonomyRuntimeStore.getState().completeCommand(response);
      if (!response.accepted) {
        Alert.alert(
          t('routeRecording.finishFailedTitle'),
          response.reason_text || t('routeRecording.rejected'),
        );
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      useAutonomyRuntimeStore.getState().failCommand(message);
      Alert.alert(t('routeRecording.finishFailedTitle'), message);
    }
  }, [t, transport]);

  const confirmFinish = useCallback(() => {
    Alert.alert(
      t('routeRecording.finishTitle'),
      runtime?.route_has_unsaved_data
        ? t('routeRecording.finishMessage')
        : t('routeRecording.emptyMessage'),
      [
        { text: t('routeRecording.cancel'), style: 'cancel' },
        {
          text: t('routeRecording.discard'),
          style: 'destructive',
          onPress: () => void requestFinish(ROUTE_RECORDING_DISPOSITION.DISCARD),
        },
        {
          text: t('routeRecording.save'),
          onPress: () => void requestFinish(ROUTE_RECORDING_DISPOSITION.SAVE),
        },
      ],
    );
  }, [requestFinish, runtime?.route_has_unsaved_data, t]);

  const disabled = commandPending || (!canStart && !canFinish);
  const label = recordingFinishable
    ? t('routeRecording.recording', { count: runtime?.route_point_count ?? 0 })
    : recordingStarting || commandPending
      ? t('routeRecording.starting')
      : t('routeRecording.button');

  return (
    <>
      <View style={styles.controlBlock}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={disabled}
          onPress={canFinish ? confirmFinish : openSetup}
          activeOpacity={0.75}
          style={[
            styles.button,
            recordingFinishable && styles.recordingButton,
            disabled && styles.disabled,
          ]}
        >
          <Ionicons
            name={recordingFinishable ? 'stop-circle-outline' : 'trail-sign-outline'}
            size={17}
            color={recordingFinishable ? theme.colors.statusError : theme.colors.accentPrimary}
          />
          <Text style={[styles.buttonText, recordingFinishable && styles.recordingText]}>{label}</Text>
        </TouchableOpacity>
        {recording ? (
          <Text style={styles.assetText} numberOfLines={1}>
            {t('routeRecording.activeRoute', { route: runtime?.route_id || routeId })}
          </Text>
        ) : null}
        <Text style={styles.assetText} numberOfLines={1}>
          {t('routeRecording.boundMap', { map: mapLabel })}
        </Text>
        {recordingFinishable ? (
          <Text style={runtime?.route_has_unsaved_data ? styles.unsavedText : styles.assetText}>
            {runtime?.route_has_unsaved_data
              ? t('routeRecording.unsaved', {
                count: runtime.route_point_count,
                distance: runtime.route_distance_m.toFixed(1),
              })
              : t('routeRecording.noSamples')}
          </Text>
        ) : null}
      </View>

      <Modal visible={setupOpen} transparent animationType="fade" onRequestClose={closeSetup}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSetup} />
          <View style={styles.dialog}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.dialogContent}
              showsVerticalScrollIndicator
            >
              <Text style={styles.dialogTitle}>{t('routeRecording.setupTitle')}</Text>
              <View style={styles.mapSelection}>
                <View style={styles.mapSelectionBody}>
                  <Text style={styles.fieldLabel}>{t('mapCatalog.selectedMap')}</Text>
                  <Text style={styles.mapSelectionValue} numberOfLines={1}>{mapLabel}</Text>
                  <Text style={styles.mapSelectionChecksum} numberOfLines={1}>
                    {selectedMap?.mapChecksum ?? ''}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.changeMapButton}
                  onPress={() => {
                    setSetupOpen(false);
                    setMapPickerOpen(true);
                  }}
                >
                  <Text style={styles.changeMapText}>{t('mapCatalog.change')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.fieldLabel}>{t('routeRecording.routeId')}</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={64}
                selectTextOnFocus
                returnKeyType="done"
                value={routeId}
                onChangeText={setRouteId}
                placeholder="route-20260906T120000Z"
                placeholderTextColor={theme.colors.textMuted}
                style={[styles.input, !routeIdValid && styles.inputInvalid]}
              />
              {!routeIdValid ? (
                <Text style={styles.errorText}>{t('routeRecording.routeIdInvalid')}</Text>
              ) : null}
              <Text style={styles.dialogHint}>{t('routeRecording.setupHint')}</Text>
              <View style={styles.dialogActions}>
                <TouchableOpacity style={styles.secondaryButton} onPress={closeSetup}>
                  <Text style={styles.secondaryButtonText}>{t('routeRecording.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={!routeIdValid || !canStart || !isCompleteMapIdentity(selectedMap)}
                  style={[
                    styles.primaryButton,
                    (!routeIdValid || !canStart || !isCompleteMapIdentity(selectedMap)) &&
                      styles.disabled,
                  ]}
                  onPress={() => void requestStart()}
                >
                  <Text style={styles.primaryButtonText}>{t('routeRecording.start')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <MapCatalogPicker
        visible={mapPickerOpen}
        title={t('mapCatalog.routeRecordingTitle')}
        confirmLabel={t('mapCatalog.continue')}
        currentIdentity={selectedMap ?? currentMapIdentity}
        onCancel={() => {
          setMapPickerOpen(false);
          if (selectedMap) setSetupOpen(true);
        }}
        onSelect={selectCatalogMap}
      />
    </>
  );
}

const styles = StyleSheet.create({
  controlBlock: { flex: 1, minWidth: 190, gap: 4 },
  button: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.accentPrimary + '66', backgroundColor: theme.colors.accentPrimary + '11' },
  recordingButton: { borderColor: theme.colors.statusError + '88', backgroundColor: theme.colors.statusErrorGlow },
  disabled: { opacity: 0.45 },
  buttonText: { color: theme.colors.accentPrimary, fontSize: 13, fontWeight: '600' },
  recordingText: { color: theme.colors.statusError },
  assetText: { color: theme.colors.textMuted, fontSize: 9, paddingHorizontal: 3 },
  unsavedText: { color: theme.colors.statusConnecting, fontSize: 9, paddingHorizontal: 3 },
  modalOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 10, backgroundColor: '#00000088' },
  dialog: { width: 430, maxWidth: '94%', maxHeight: '94%', flexShrink: 1, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgElevated, overflow: 'hidden' },
  dialogContent: { padding: 16 },
  dialogTitle: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: '700' },
  dialogHint: { color: theme.colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  fieldLabel: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '700', marginTop: 15, marginBottom: 6 },
  mapSelection: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingHorizontal: 12, paddingBottom: 9, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgInset },
  mapSelectionBody: { flex: 1, minWidth: 0 },
  mapSelectionValue: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: '700' },
  mapSelectionChecksum: { color: theme.colors.textMuted, fontFamily: 'SpaceMono', fontSize: 8, marginTop: 3 },
  changeMapButton: { minHeight: 36, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: theme.colors.accentPrimary + '77' },
  changeMapText: { color: theme.colors.accentPrimary, fontSize: 11, fontWeight: '700' },
  input: { minHeight: 46, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.borderDefault, color: theme.colors.textValue, backgroundColor: theme.colors.bgInset, fontFamily: 'SpaceMono', fontSize: 12 },
  inputInvalid: { borderColor: theme.colors.statusError },
  errorText: { color: theme.colors.statusError, fontSize: 10, marginTop: 5 },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  secondaryButton: { minHeight: 42, minWidth: 90, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: theme.colors.borderDefault },
  secondaryButtonText: { color: theme.colors.textSecondary, fontWeight: '700' },
  primaryButton: { minHeight: 42, minWidth: 120, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: theme.colors.accentPrimary },
  primaryButtonText: { color: '#061014', fontWeight: '800' },
});
