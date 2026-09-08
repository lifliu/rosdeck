import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { theme } from '../constants/theme';
import { buildRoutePointPresets } from '../lib/mission/checkpoint-editor';
import {
  getRouteCheckpoints,
  updateRouteCheckpoints,
  validateRouteCheckpointPlan,
} from '../lib/mission/api';
import {
  ROUTE_CHECKPOINT_ACTION_TYPE,
  ROUTE_CHECKPOINT_FAILURE,
  type RouteCheckpointActionConfig,
  type RouteCheckpointActionType,
  type RouteCheckpointConfig,
  type RouteCheckpointPlan,
  type RouteEntry,
} from '../lib/mission/types';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useRosStore } from '../stores/useRosStore';

interface RouteCheckpointEditorProps {
  visible: boolean;
  route: RouteEntry | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}

const ACTION_ORDER: readonly RouteCheckpointActionType[] = [
  ROUTE_CHECKPOINT_ACTION_TYPE.DWELL,
  ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO,
  ROUTE_CHECKPOINT_ACTION_TYPE.RECORD,
  ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE,
];

function clonePlan(plan: RouteCheckpointPlan): RouteCheckpointPlan {
  return {
    ...plan,
    checkpoints: plan.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      actions: checkpoint.actions.map((action) => ({ ...action })),
    })),
  };
}

function defaultAction(type: RouteCheckpointActionType): RouteCheckpointActionConfig {
  return {
    type,
    dwellMs: type === ROUTE_CHECKPOINT_ACTION_TYPE.DWELL ? 1000 : 0,
    photoCount: type === ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO ? 1 : 0,
    recordSeconds: type === ROUTE_CHECKPOINT_ACTION_TYPE.RECORD ? 5 : 0,
    recognizeTarget: type === ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE ? 'meter' : '',
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function actionLabel(type: RouteCheckpointActionType, zh: boolean): string {
  switch (type) {
    case ROUTE_CHECKPOINT_ACTION_TYPE.DWELL:
      return zh ? '停留' : 'Dwell';
    case ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO:
      return zh ? '拍照' : 'Photo';
    case ROUTE_CHECKPOINT_ACTION_TYPE.RECORD:
      return zh ? '录像' : 'Record';
    case ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE:
      return zh ? '识别' : 'Recognize';
  }
}

function actionIcon(type: RouteCheckpointActionType): keyof typeof Ionicons.glyphMap {
  switch (type) {
    case ROUTE_CHECKPOINT_ACTION_TYPE.DWELL:
      return 'timer-outline';
    case ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO:
      return 'camera-outline';
    case ROUTE_CHECKPOINT_ACTION_TYPE.RECORD:
      return 'videocam-outline';
    case ROUTE_CHECKPOINT_ACTION_TYPE.RECOGNIZE:
      return 'scan-outline';
  }
}

/**
 * 路线检查点的手机端编辑器。
 *
 * 每次打开都从 Mission Manager 读取完整快照，保存时回传同一个 checksum 做
 * 乐观并发校验。这样 APP 不会用陈旧草稿覆盖刚录制或被其他终端修改的路线。
 */
export function RouteCheckpointEditor({
  visible,
  route,
  onCancel,
  onSaved,
}: RouteCheckpointEditorProps) {
  const transport = useRosStore((state) => state.transport);
  const connectionStatus = useRosStore((state) => state.connection.status);
  const language = useSettingsStore((state) => state.language);
  const zh = language === 'zh';
  // 路线目录刷新会创建新的 RouteEntry 对象，但同一个 routeId 仍表示同一编辑会话。
  // effect 只依赖稳定 ID，避免保存后的目录刷新误把当前请求判为过期而阻止关窗。
  const routeId = route?.routeId ?? '';
  const [plan, setPlan] = useState<RouteCheckpointPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const requestSerial = useRef(0);

  const close = useCallback(() => {
    requestSerial.current += 1;
    onCancel();
  }, [onCancel]);

  const refresh = useCallback(async () => {
    const serial = ++requestSerial.current;
    setLoading(true);
    setSaving(false);
    setError('');
    setPlan(null);
    if (!routeId || !transport || connectionStatus !== 'connected') {
      setError(zh ? '机器人未连接，无法读取路线。' : 'Robot is not connected.');
      setLoading(false);
      return;
    }
    try {
      const current = await getRouteCheckpoints(transport, routeId);
      if (serial === requestSerial.current) setPlan(clonePlan(current));
    } catch (caught: any) {
      if (serial === requestSerial.current) {
        setError(caught?.message || String(caught));
      }
    } finally {
      if (serial === requestSerial.current) setLoading(false);
    }
  }, [connectionStatus, routeId, transport, zh]);

  useEffect(() => {
    if (visible) {
      void refresh();
      return () => {
        requestSerial.current += 1;
      };
    }
    requestSerial.current += 1;
    setPlan(null);
    setError('');
    setLoading(false);
    setSaving(false);
  }, [refresh, visible]);

  const validationError = useMemo(
    () => plan ? validateRouteCheckpointPlan(plan.checkpoints, plan.pointCount) : null,
    [plan],
  );
  const positionPresets = useMemo(
    () => buildRoutePointPresets(plan?.pointCount ?? 0),
    [plan?.pointCount],
  );

  const updateCheckpoint = useCallback(
    (index: number, updater: (checkpoint: RouteCheckpointConfig) => RouteCheckpointConfig) => {
      setPlan((current) => current ? {
        ...current,
        checkpoints: current.checkpoints.map((checkpoint, checkpointIndex) =>
          checkpointIndex === index ? updater(checkpoint) : checkpoint),
      } : current);
    },
    [],
  );

  const addCheckpoint = useCallback(() => {
    setPlan((current) => {
      if (!current) return current;
      const existing = new Set(current.checkpoints.map((checkpoint) => checkpoint.checkpointId));
      let suffix = current.checkpoints.length + 1;
      while (existing.has(`cp-${suffix}`)) suffix += 1;
      const previousIndex = current.checkpoints.length > 0
        ? current.checkpoints[current.checkpoints.length - 1].pointIndex
        : -1;
      const pointIndex = Math.min(current.pointCount - 1, Math.max(0, previousIndex + 1));
      return {
        ...current,
        checkpoints: [
          ...current.checkpoints,
          {
            checkpointId: `cp-${suffix}`,
            pointIndex,
            onFailure: ROUTE_CHECKPOINT_FAILURE.FAIL_MISSION,
            attempts: 2,
            actions: [defaultAction(ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO)],
          },
        ],
      };
    });
  }, []);

  const removeCheckpoint = useCallback((index: number) => {
    setPlan((current) => current ? {
      ...current,
      checkpoints: current.checkpoints.filter((_checkpoint, checkpointIndex) =>
        checkpointIndex !== index),
    } : current);
  }, []);

  const save = useCallback(async () => {
    if (!plan || !routeId || !transport || validationError) return;
    const serial = requestSerial.current;
    setSaving(true);
    setError('');
    try {
      const response = await updateRouteCheckpoints(transport, routeId, plan);
      if (serial !== requestSerial.current) return;
      if (!response.accepted) {
        setError(response.reasonText || (zh ? '保存被 Mission Manager 拒绝。' : 'Save was rejected.'));
        return;
      }
      // update 成功即表示机器人端已经原子提交。先关闭当前编辑会话，再让父页面
      // 重读目录；父层刷新会有意清空旧选择，若反过来执行会使 routeId 短暂变空，
      // 从而触发本组件 effect 清理并把这次成功响应误判为过期。
      close();
      await onSaved();
    } catch (caught: any) {
      if (serial === requestSerial.current) {
        setError(caught?.message || String(caught));
      }
    } finally {
      if (serial === requestSerial.current) setSaving(false);
    }
  }, [close, onSaved, plan, routeId, transport, validationError, zh]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        <View style={styles.dialog}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text style={styles.title}>{zh ? '编辑路线检查点' : 'Edit route checkpoints'}</Text>
              <Text style={styles.subtitle} numberOfLines={2}>
                {route?.routeId || '-'}{plan ? ` · ${plan.pointCount}${zh ? '个路线点' : ' route points'}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={zh ? '关闭检查点编辑器' : 'Close checkpoint editor'}
              style={styles.closeButton}
              onPress={close}
            >
              <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.body}>
            {loading ? (
              <View style={styles.centerState}>
                <ActivityIndicator color={theme.colors.accentPrimary} />
                <Text style={styles.stateText}>{zh ? '正在读取机器人端配置…' : 'Loading robot configuration…'}</Text>
              </View>
            ) : !plan ? (
              <View style={styles.centerState}>
                <Ionicons name="warning-outline" size={25} color={theme.colors.statusError} />
                <Text style={styles.errorText}>{error || (zh ? '无法读取检查点。' : 'Unable to load checkpoints.')}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={() => void refresh()}>
                  <Text style={styles.retryText}>{zh ? '重新读取' : 'Retry'}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView
                contentContainerStyle={styles.checkpointList}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.guide}>
                  <Ionicons name="information-circle-outline" size={18} color={theme.colors.accentPrimary} />
                  <Text style={styles.guideText}>
                    {zh
                      ? '机器狗到达指定路线点后，会按顺序执行下方动作。任务或导航运行时后端会禁止修改。'
                      : 'Actions run in order after the robot reaches the selected route point. Editing is blocked while a mission or navigation is active.'}
                  </Text>
                </View>
                {plan.checkpoints.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Ionicons name="location-outline" size={28} color={theme.colors.textMuted} />
                    <Text style={styles.stateText}>{zh ? '这条路线还没有检查点，当前巡检只会走完路线。' : 'This route has no checkpoints; inspection only traverses it.'}</Text>
                  </View>
                ) : null}
                {plan.checkpoints.map((checkpoint, checkpointIndex) => (
                  <View key={`${checkpoint.checkpointId}-${checkpointIndex}`} style={styles.checkpointCard}>
                    <View style={styles.checkpointHeader}>
                      <View style={styles.indexBadge}><Text style={styles.indexText}>{checkpointIndex + 1}</Text></View>
                      <TextInput
                        accessibilityLabel={zh ? `第 ${checkpointIndex + 1} 个检查点名称` : `Checkpoint ${checkpointIndex + 1} name`}
                        autoCapitalize="none"
                        autoCorrect={false}
                        maxLength={64}
                        placeholder="cp-1"
                        placeholderTextColor={theme.colors.textMuted}
                        style={[styles.textInput, styles.checkpointName]}
                        value={checkpoint.checkpointId}
                        onChangeText={(checkpointId) => updateCheckpoint(
                          checkpointIndex,
                          (current) => ({ ...current, checkpointId }),
                        )}
                      />
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={zh ? `删除检查点 ${checkpoint.checkpointId}` : `Delete ${checkpoint.checkpointId}`}
                        style={styles.deleteButton}
                        onPress={() => removeCheckpoint(checkpointIndex)}
                      >
                        <Ionicons name="trash-outline" size={18} color={theme.colors.statusError} />
                      </TouchableOpacity>
                    </View>

                    <Text style={styles.fieldLabel}>{zh ? '路线位置' : 'ROUTE POSITION'}</Text>
                    <View style={styles.stepperRow}>
                      {[-10, -1].map((step) => (
                        <TouchableOpacity
                          key={step}
                          style={styles.stepButton}
                          onPress={() => updateCheckpoint(checkpointIndex, (current) => ({
                            ...current,
                            pointIndex: clampInteger(current.pointIndex + step, 0, plan.pointCount - 1),
                          }))}
                        ><Text style={styles.stepText}>{step}</Text></TouchableOpacity>
                      ))}
                      <View style={styles.pointValue}>
                        <TextInput
                          accessibilityLabel={zh ? '路线点序号' : 'Route point number'}
                          keyboardType="number-pad"
                          selectTextOnFocus
                          style={styles.pointIndexInput}
                          value={String(checkpoint.pointIndex + 1)}
                          onChangeText={(text) => {
                            const oneBasedPoint = Number.parseInt(text, 10);
                            if (!Number.isFinite(oneBasedPoint)) return;
                            updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              pointIndex: clampInteger(
                                oneBasedPoint - 1, 0, plan.pointCount - 1,
                              ),
                            }));
                          }}
                        />
                        <Text style={styles.pointTotal}>/ {plan.pointCount}</Text>
                      </View>
                      {[1, 10].map((step) => (
                        <TouchableOpacity
                          key={step}
                          style={styles.stepButton}
                          onPress={() => updateCheckpoint(checkpointIndex, (current) => ({
                            ...current,
                            pointIndex: clampInteger(current.pointIndex + step, 0, plan.pointCount - 1),
                          }))}
                        ><Text style={styles.stepText}>+{step}</Text></TouchableOpacity>
                      ))}
                    </View>
                    <View style={styles.positionPresets}>
                      {positionPresets.map((preset) => {
                        const active = checkpoint.pointIndex === preset.pointIndex;
                        return (
                          <TouchableOpacity
                            key={preset.pointIndex}
                            style={[styles.presetButton, active && styles.selectedChip]}
                            onPress={() => updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              pointIndex: preset.pointIndex,
                            }))}
                          >
                            <Text style={[styles.presetText, active && styles.selectedChipText]}>{preset.percentage}%</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <View style={styles.policyRow}>
                      <View style={styles.policyGroup}>
                        <Text style={styles.fieldLabel}>{zh ? '动作失败时' : 'ON FAILURE'}</Text>
                        <View style={styles.chipRow}>
                          {[
                            [ROUTE_CHECKPOINT_FAILURE.FAIL_MISSION, zh ? '终止任务' : 'Fail mission'],
                            [ROUTE_CHECKPOINT_FAILURE.SKIP, zh ? '记录并继续' : 'Skip'],
                          ].map(([value, label]) => {
                            const selected = checkpoint.onFailure === value;
                            return <TouchableOpacity key={value} style={[styles.chip, selected && styles.selectedChip]} onPress={() => updateCheckpoint(checkpointIndex, (current) => ({ ...current, onFailure: value as 0 | 1 }))}><Text style={[styles.chipText, selected && styles.selectedChipText]}>{label}</Text></TouchableOpacity>;
                          })}
                        </View>
                      </View>
                      <View style={styles.policyGroup}>
                        <Text style={styles.fieldLabel}>{zh ? '最多尝试' : 'ATTEMPTS'}</Text>
                        <View style={styles.chipRow}>
                          {[1, 2, 3].map((attempts) => {
                            const selected = checkpoint.attempts === attempts;
                            return <TouchableOpacity key={attempts} style={[styles.attemptChip, selected && styles.selectedChip]} onPress={() => updateCheckpoint(checkpointIndex, (current) => ({ ...current, attempts }))}><Text style={[styles.chipText, selected && styles.selectedChipText]}>{attempts}</Text></TouchableOpacity>;
                          })}
                        </View>
                      </View>
                    </View>

                    <Text style={styles.fieldLabel}>{zh ? '到点后按顺序执行' : 'ACTIONS IN ORDER'}</Text>
                    {checkpoint.actions.map((action, actionIndex) => (
                      <View key={`${action.type}-${actionIndex}`} style={styles.actionRow}>
                        <View style={styles.actionIdentity}>
                          <Ionicons name={actionIcon(action.type)} size={18} color={theme.colors.accentPrimary} />
                          <Text style={styles.actionName}>{actionIndex + 1}. {actionLabel(action.type, zh)}</Text>
                        </View>
                        {action.type === ROUTE_CHECKPOINT_ACTION_TYPE.DWELL ? (
                          <NumericInput
                            accessibilityLabel={zh ? '停留毫秒' : 'Dwell milliseconds'}
                            suffix="ms"
                            value={action.dwellMs}
                            onChange={(dwellMs) => updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              actions: current.actions.map((item, index) => index === actionIndex ? { ...item, dwellMs } : item),
                            }))}
                          />
                        ) : action.type === ROUTE_CHECKPOINT_ACTION_TYPE.PHOTO ? (
                          <NumericInput
                            accessibilityLabel={zh ? '拍照张数' : 'Photo count'}
                            suffix={zh ? '张' : 'shots'}
                            value={action.photoCount}
                            onChange={(photoCount) => updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              actions: current.actions.map((item, index) => index === actionIndex ? { ...item, photoCount } : item),
                            }))}
                          />
                        ) : action.type === ROUTE_CHECKPOINT_ACTION_TYPE.RECORD ? (
                          <NumericInput
                            accessibilityLabel={zh ? '录像秒数' : 'Recording seconds'}
                            suffix="s"
                            value={action.recordSeconds}
                            decimal
                            onChange={(recordSeconds) => updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              actions: current.actions.map((item, index) => index === actionIndex ? { ...item, recordSeconds } : item),
                            }))}
                          />
                        ) : (
                          <TextInput
                            accessibilityLabel={zh ? '识别目标' : 'Recognition target'}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={zh ? '例：meter-01' : 'e.g. meter-01'}
                            placeholderTextColor={theme.colors.textMuted}
                            style={[styles.textInput, styles.actionInput]}
                            value={action.recognizeTarget}
                            onChangeText={(recognizeTarget) => updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              actions: current.actions.map((item, index) => index === actionIndex ? { ...item, recognizeTarget } : item),
                            }))}
                          />
                        )}
                        <View style={styles.actionButtons}>
                          <TouchableOpacity
                            accessibilityLabel={zh ? '上移动作' : 'Move action up'}
                            disabled={actionIndex === 0}
                            style={[styles.smallIconButton, actionIndex === 0 && styles.disabled]}
                            onPress={() => updateCheckpoint(checkpointIndex, (current) => {
                              const actions = [...current.actions];
                              [actions[actionIndex - 1], actions[actionIndex]] = [actions[actionIndex], actions[actionIndex - 1]];
                              return { ...current, actions };
                            })}
                          ><Ionicons name="arrow-up" size={16} color={theme.colors.textSecondary} /></TouchableOpacity>
                          <TouchableOpacity
                            accessibilityLabel={zh ? '下移动作' : 'Move action down'}
                            disabled={actionIndex === checkpoint.actions.length - 1}
                            style={[styles.smallIconButton, actionIndex === checkpoint.actions.length - 1 && styles.disabled]}
                            onPress={() => updateCheckpoint(checkpointIndex, (current) => {
                              const actions = [...current.actions];
                              [actions[actionIndex], actions[actionIndex + 1]] = [actions[actionIndex + 1], actions[actionIndex]];
                              return { ...current, actions };
                            })}
                          ><Ionicons name="arrow-down" size={16} color={theme.colors.textSecondary} /></TouchableOpacity>
                          <TouchableOpacity
                            accessibilityLabel={zh ? '删除动作' : 'Delete action'}
                            style={styles.smallIconButton}
                            onPress={() => updateCheckpoint(checkpointIndex, (current) => ({
                              ...current,
                              actions: current.actions.filter((_item, index) => index !== actionIndex),
                            }))}
                          ><Ionicons name="close" size={17} color={theme.colors.statusError} /></TouchableOpacity>
                        </View>
                      </View>
                    ))}
                    <View style={styles.addActionRow}>
                      <Text style={styles.addActionLabel}>{zh ? '添加动作' : 'Add action'}</Text>
                      {ACTION_ORDER.map((type) => (
                        <TouchableOpacity
                          key={type}
                          disabled={checkpoint.actions.length >= 16}
                          style={[styles.addActionButton, checkpoint.actions.length >= 16 && styles.disabled]}
                          onPress={() => updateCheckpoint(checkpointIndex, (current) => ({
                            ...current,
                            actions: [...current.actions, defaultAction(type)],
                          }))}
                        >
                          <Ionicons name={actionIcon(type)} size={16} color={theme.colors.accentPrimary} />
                          <Text style={styles.addActionText}>{actionLabel(type, zh)}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                ))}
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={plan.checkpoints.length >= 256}
                  style={[styles.addCheckpointButton, plan.checkpoints.length >= 256 && styles.disabled]}
                  onPress={addCheckpoint}
                >
                  <Ionicons name="add-circle-outline" size={20} color={theme.colors.accentPrimary} />
                  <Text style={styles.addCheckpointText}>{zh ? '添加检查点' : 'Add checkpoint'}</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>

          {plan && error ? <Text style={styles.footerError}>{error}</Text> : null}
          {plan && validationError ? <Text style={styles.footerWarning}>{validationError}</Text> : null}
          <View style={styles.footer}>
            <TouchableOpacity style={styles.secondaryButton} disabled={saving} onPress={close}>
              <Text style={styles.secondaryText}>{zh ? '取消' : 'Cancel'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: !plan || !!validationError || saving, busy: saving }}
              disabled={!plan || !!validationError || saving}
              style={[styles.primaryButton, (!plan || !!validationError || saving) && styles.disabled]}
              onPress={() => void save()}
            >
              {saving ? <ActivityIndicator size="small" color={theme.colors.bgBase} /> : <Ionicons name="save-outline" size={18} color={theme.colors.bgBase} />}
              <Text style={styles.primaryText}>{saving ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存检查点' : 'Save checkpoints')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NumericInput({
  accessibilityLabel,
  value,
  suffix,
  decimal = false,
  onChange,
}: {
  accessibilityLabel: string;
  value: number;
  suffix: string;
  decimal?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.numericInput}>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        keyboardType={decimal ? 'decimal-pad' : 'number-pad'}
        selectTextOnFocus
        style={styles.numericText}
        value={Number.isFinite(value) ? String(value) : ''}
        onChangeText={(text) => onChange(text.trim() === '' ? Number.NaN : Number(text))}
      />
      <Text style={styles.numericSuffix}>{suffix}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8, backgroundColor: '#000000B8' },
  dialog: { width: 780, maxWidth: '98%', height: '94%', maxHeight: 760, borderRadius: theme.radius.xl, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgElevated, overflow: 'hidden' },
  header: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  heading: { flex: 1, minWidth: 0 },
  title: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  subtitle: { ...theme.typography.monoXs, color: theme.colors.textMuted, marginTop: 3 },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSurface },
  body: { flex: 1, minHeight: 0 },
  centerState: { flex: 1, minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 9, padding: 18 },
  stateText: { ...theme.typography.bodySm, maxWidth: 430, color: theme.colors.textMuted, textAlign: 'center' },
  errorText: { ...theme.typography.bodySm, maxWidth: 520, color: theme.colors.statusError, textAlign: 'center' },
  retryButton: { minHeight: 40, minWidth: 112, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.accentPrimary + '88' },
  retryText: { color: theme.colors.accentPrimary, fontSize: 13, fontWeight: '700' },
  checkpointList: { padding: 12, gap: 12 },
  guide: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: theme.radius.md, backgroundColor: theme.colors.accentPrimaryMuted },
  guideText: { flex: 1, color: theme.colors.textSecondary, fontSize: 11, lineHeight: 17 },
  emptyState: { minHeight: 96, alignItems: 'center', justifyContent: 'center', gap: 7, padding: 12, borderRadius: theme.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.borderDefault },
  checkpointCard: { gap: 9, padding: 12, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgInset },
  checkpointHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  indexBadge: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentPrimaryMuted },
  indexText: { ...theme.typography.monoSm, color: theme.colors.accentPrimary, fontWeight: '700' },
  textInput: { minHeight: 42, paddingHorizontal: 11, paddingVertical: 7, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSurface, color: theme.colors.textPrimary, fontSize: 13 },
  checkpointName: { flex: 1, fontFamily: 'SpaceMono' },
  deleteButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.statusError + '55' },
  fieldLabel: { ...theme.typography.labelSm, color: theme.colors.textMuted, marginTop: 2 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: { width: 50, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSurface },
  stepText: { ...theme.typography.monoSm, color: theme.colors.textSecondary },
  pointValue: { flex: 1, minWidth: 86, minHeight: 40, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 5 },
  pointIndexInput: { minWidth: 62, paddingHorizontal: 6, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.accentPrimary + '88', ...theme.typography.monoLg, color: theme.colors.textPrimary, fontWeight: '700', textAlign: 'center' },
  pointTotal: { ...theme.typography.monoXs, color: theme.colors.textMuted },
  positionPresets: { flexDirection: 'row', gap: 6 },
  presetButton: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  presetText: { ...theme.typography.monoXs, color: theme.colors.textMuted },
  policyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  policyGroup: { minWidth: 210, flex: 1, gap: 6 },
  chipRow: { flexDirection: 'row', gap: 6 },
  chip: { minHeight: 38, flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSurface },
  attemptChip: { width: 42, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSurface },
  selectedChip: { borderColor: theme.colors.accentPrimary, backgroundColor: theme.colors.accentPrimaryMuted },
  chipText: { color: theme.colors.textSecondary, fontSize: 11, fontWeight: '600' },
  selectedChipText: { color: theme.colors.accentPrimary },
  actionRow: { minHeight: 50, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 7, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: theme.colors.bgSurface },
  actionIdentity: { width: 112, flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionName: { flex: 1, color: theme.colors.textValue, fontSize: 12, fontWeight: '600' },
  actionInput: { flex: 1, minWidth: 130 },
  numericInput: { flex: 1, minWidth: 100, maxWidth: 190, minHeight: 40, flexDirection: 'row', alignItems: 'center', borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgInset },
  numericText: { flex: 1, minWidth: 48, paddingHorizontal: 10, paddingVertical: 7, color: theme.colors.textPrimary, fontFamily: 'SpaceMono', textAlign: 'right' },
  numericSuffix: { minWidth: 34, paddingRight: 9, color: theme.colors.textMuted, fontSize: 10 },
  actionButtons: { marginLeft: 'auto', flexDirection: 'row', gap: 4 },
  smallIconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.sm, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  addActionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 2 },
  addActionLabel: { color: theme.colors.textMuted, fontSize: 11, marginRight: 2 },
  addActionButton: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.accentPrimary + '44' },
  addActionText: { color: theme.colors.accentPrimary, fontSize: 11, fontWeight: '600' },
  addCheckpointButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: theme.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.accentPrimary + '77' },
  addCheckpointText: { color: theme.colors.accentPrimary, fontSize: 13, fontWeight: '700' },
  footerError: { paddingHorizontal: 14, paddingTop: 7, color: theme.colors.statusError, fontSize: 11, lineHeight: 16 },
  footerWarning: { paddingHorizontal: 14, paddingTop: 7, color: theme.colors.statusConnecting, fontSize: 11, lineHeight: 16 },
  footer: { minHeight: 66, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
  secondaryButton: { minWidth: 96, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault },
  secondaryText: { color: theme.colors.textSecondary, fontSize: 13, fontWeight: '700' },
  primaryButton: { minWidth: 152, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 14, borderRadius: theme.radius.md, backgroundColor: theme.colors.accentPrimary },
  primaryText: { color: theme.colors.bgBase, fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.4 },
});
