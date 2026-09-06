import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation } from '../lib/i18n';
import { useRosStore } from '../stores/useRosStore';

export const START_NAVIGATION_TOPIC = '/rosdeck/start_navigation';
export const NAVIGATION_STATUS_TOPIC = '/rosdeck/navigation_status';
export const NAVIGATION_MESSAGE_TYPE = 'std_msgs/msg/Bool';
export const START_NAVIGATION_MESSAGE = { data: true } as const;
export const STOP_NAVIGATION_MESSAGE = { data: false } as const;

const START_TIMEOUT_MS = 90000;
const STOP_TIMEOUT_MS = 60000;
const STATUS_STALE_TIMEOUT_MS = 3500;
type PendingCommand = 'start' | 'stop';

export type NavigationRuntimeState =
  | 'unknown'
  | 'disabled'
  | 'idle'
  | 'starting'
  | 'running_managed'
  | 'running_external'
  | 'switchable_inspection'
  | 'blocked_inspection'
  | 'blocked_inspection_unknown'
  | 'partial'
  | 'stopping'
  | 'error';

export function extractNavigationStatus(message: any): string {
  return typeof message?.data === 'string' ? message.data : '';
}

/**
 * 将 Bridge 的线协议收敛成 UI 状态。
 *
 * 外部运行与 Bridge 托管运行必须分开：前者只能展示和禁用重复启动，APP
 * 不能停止一个不属于 Bridge 的手工进程组。
 */
export function parseNavigationRuntimeState(status: string): NavigationRuntimeState {
  if (status === 'disabled') return 'disabled';
  if (status === 'idle' || status.startsWith('stopped:')) return 'idle';
  if (status.startsWith('starting:') || status.startsWith('switching:')) return 'starting';
  if (status === 'running:managed') return 'running_managed';
  if (status === 'running:external' || status === 'already_running') return 'running_external';
  if (status === 'switchable:inspection_runtime') return 'switchable_inspection';
  if (status === 'blocked:inspection_runtime' ||
    status === 'blocked:inspection_mission_active') return 'blocked_inspection';
  if (status.startsWith('blocked:inspection_')) return 'blocked_inspection_unknown';
  if (status.startsWith('partial:')) return 'partial';
  if (
    status.startsWith('stopping:') ||
    status.startsWith('terminating:') ||
    status.startsWith('killing:')
  ) return 'stopping';
  if (status.startsWith('error:') || status.startsWith('exited:')) return 'error';
  return 'unknown';
}

export function NavigationControl({ compact = false }: { compact?: boolean }) {
  const connectionStatus = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const [runtimeState, setRuntimeState] = useState<NavigationRuntimeState>('unknown');
  const [waiting, setWaiting] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusStaleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PendingCommand | null>(null);
  const launchInitiatedRef = useRef(false);

  const clearAckTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const clearStatusStaleTimeout = useCallback(() => {
    if (statusStaleTimeoutRef.current) clearTimeout(statusStaleTimeoutRef.current);
    statusStaleTimeoutRef.current = null;
  }, []);

  const finishPending = useCallback(() => {
    pendingRef.current = null;
    clearAckTimeout();
    setWaiting(false);
  }, [clearAckTimeout]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || !transport || url?.startsWith('demo://')) {
      pendingRef.current = null;
      launchInitiatedRef.current = false;
      setWaiting(false);
      setRuntimeState('unknown');
      clearAckTimeout();
      clearStatusStaleTimeout();
      return;
    }

    // Bridge 以 transient-local + 1 Hz heartbeat 发布权威状态；组件每次打开
    // 都重新同步，因此手工启动的 SLAM/Planner 不会被误判为空闲。
    const subscription = transport.subscribe(
      NAVIGATION_STATUS_TOPIC,
      'std_msgs/msg/String',
      (message) => {
        const status = extractNavigationStatus(message);
        if (!status) return;

        const nextState = parseNavigationRuntimeState(status);
        setRuntimeState(nextState);

        // Bridge 每秒发送一次心跳。状态源消失后必须回到不可操作状态，不能让
        // transient-local 的最后一帧继续把“启动/停止”按钮伪装成可用。
        clearStatusStaleTimeout();
        statusStaleTimeoutRef.current = setTimeout(() => {
          setRuntimeState('unknown');
          if (pendingRef.current || launchInitiatedRef.current) {
            const command = pendingRef.current || 'start';
            launchInitiatedRef.current = false;
            finishPending();
            Alert.alert(
              t(command === 'stop' ? 'navigation.stopFailedTitle' : 'navigation.failedTitle'),
              t('navigation.bridgeMissing'),
            );
          }
        }, STATUS_STALE_TIMEOUT_MS);

        if (nextState === 'starting' && pendingRef.current === 'start') {
          // Bridge 已接管进程组后，启动按钮立即变成可操作的“取消启动”。
          // 重定位可能需要一分钟以上，不能强迫用户等待固定超时。
          finishPending();
          return;
        }
        if (nextState === 'running_managed' && launchInitiatedRef.current) {
          launchInitiatedRef.current = false;
          if (pendingRef.current === 'start') finishPending();
          Alert.alert(t('navigation.startedTitle'), t('navigation.startedMessage'));
          return;
        }
        if (nextState === 'running_external' && pendingRef.current === 'start') {
          launchInitiatedRef.current = false;
          finishPending();
          Alert.alert(
            t('navigation.externalRunningTitle'),
            t('navigation.externalRunningMessage'),
          );
          return;
        }
        if (status.startsWith('stopped:') && pendingRef.current === 'stop') {
          launchInitiatedRef.current = false;
          finishPending();
          Alert.alert(t('navigation.stoppedTitle'), t('navigation.stoppedMessage'));
          return;
        }
        if (nextState === 'error' && (pendingRef.current || launchInitiatedRef.current)) {
          const command = pendingRef.current || 'start';
          launchInitiatedRef.current = false;
          finishPending();
          Alert.alert(
            t(command === 'stop' ? 'navigation.stopFailedTitle' : 'navigation.failedTitle'),
            t('navigation.error', { message: status.replace(/^error:/, '') }),
          );
        }
      },
    );

    return () => {
      subscription.unsubscribe();
      clearStatusStaleTimeout();
    };
  }, [
    connectionStatus,
    transport,
    url,
    clearAckTimeout,
    clearStatusStaleTimeout,
    finishPending,
    t,
  ]);

  useEffect(
    () => () => {
      clearAckTimeout();
      clearStatusStaleTimeout();
    },
    [clearAckTimeout, clearStatusStaleTimeout],
  );

  const sendRequest = useCallback((command: PendingCommand) => {
    if (connectionStatus !== 'connected' || !transport || url?.startsWith('demo://')) {
      Alert.alert(t('navigation.failedTitle'), t('navigation.disconnected'));
      return;
    }

    setWaiting(true);
    pendingRef.current = command;
    launchInitiatedRef.current = command === 'start';
    // 单个 Topic 只使用单一 Bool 类型，消除旧实现 Bool/String 同名冲突。
    transport.publish(
      START_NAVIGATION_TOPIC,
      NAVIGATION_MESSAGE_TYPE,
      command === 'start' ? START_NAVIGATION_MESSAGE : STOP_NAVIGATION_MESSAGE,
    );

    clearAckTimeout();
    timeoutRef.current = setTimeout(() => {
      pendingRef.current = null;
      launchInitiatedRef.current = false;
      setWaiting(false);
      Alert.alert(
        t(command === 'stop' ? 'navigation.stopFailedTitle' : 'navigation.failedTitle'),
        t('navigation.bridgeMissing'),
      );
    }, command === 'stop' ? STOP_TIMEOUT_MS : START_TIMEOUT_MS);
  }, [connectionStatus, transport, url, clearAckTimeout, t]);

  const managedRunning = runtimeState === 'running_managed';
  const managedStarting = runtimeState === 'starting';
  const switchFromInspection = runtimeState === 'switchable_inspection';
  const confirmCommand = useCallback(() => {
    if (runtimeState !== 'idle' && runtimeState !== 'starting' &&
      runtimeState !== 'running_managed' && runtimeState !== 'switchable_inspection') return;
    const command: PendingCommand = managedRunning || managedStarting ? 'stop' : 'start';
    const cancellingStart = command === 'stop' && managedStarting;
    Alert.alert(
      t(cancellingStart
        ? 'navigation.cancelStartConfirmTitle'
        : managedRunning
          ? 'navigation.stopConfirmTitle'
          : switchFromInspection
            ? 'navigation.switchConfirmTitle'
            : 'navigation.confirmTitle'),
      t(cancellingStart
        ? 'navigation.cancelStartConfirmMessage'
        : managedRunning
          ? 'navigation.stopConfirmMessage'
          : switchFromInspection
            ? 'navigation.switchConfirmMessage'
            : 'navigation.confirmMessage'),
      [
        { text: t('navigation.cancel'), style: 'cancel' },
        {
          text: t(command === 'stop' ? 'navigation.stop' : 'navigation.start'),
          style: command === 'stop' ? 'destructive' : 'default',
          onPress: () => sendRequest(command),
        },
      ],
    );
  }, [managedRunning, managedStarting, runtimeState, sendRequest, switchFromInspection, t]);

  const synchronized = runtimeState !== 'unknown';
  const actionable = runtimeState === 'idle' || runtimeState === 'starting' ||
    runtimeState === 'running_managed' || runtimeState === 'switchable_inspection';
  const disabled =
    connectionStatus !== 'connected' ||
    !transport ||
    url?.startsWith('demo://') ||
    !synchronized ||
    !actionable ||
    waiting;

  const labelKey = waiting
    ? pendingRef.current === 'stop'
      ? 'navigation.stoppingButton'
      : 'navigation.startingButton'
    : runtimeState === 'starting'
      ? 'navigation.cancelStartingButton'
      : runtimeState === 'stopping'
      ? 'navigation.stoppingButton'
      : runtimeState === 'running_external'
        ? 'navigation.externalRunningButton'
        : runtimeState === 'blocked_inspection'
          ? 'navigation.inspectionRunningButton'
        : runtimeState === 'blocked_inspection_unknown'
          ? 'navigation.inspectionCheckingButton'
        : runtimeState === 'partial' || runtimeState === 'error'
          ? 'navigation.incompleteButton'
          : runtimeState === 'disabled'
            ? 'navigation.unavailableButton'
            : runtimeState === 'unknown'
              ? 'navigation.checkingButton'
              : managedRunning
                ? 'navigation.stopButton'
                : 'navigation.button';

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t(labelKey)}
      style={[
        styles.button,
        managedRunning && styles.stopButton,
        runtimeState === 'running_external' && styles.runningButton,
        compact && styles.compactButton,
        disabled && styles.disabled,
      ]}
      disabled={disabled}
      onPress={confirmCommand}
      activeOpacity={0.75}
    >
      <Ionicons
        name={
          waiting || runtimeState === 'stopping'
            ? 'hourglass-outline'
            : runtimeState === 'starting'
              ? 'close-circle-outline'
            : managedRunning
              ? 'stop-circle-outline'
              : runtimeState === 'running_external'
                ? 'navigate'
                : runtimeState === 'blocked_inspection'
                  ? 'git-branch-outline'
                : runtimeState === 'blocked_inspection_unknown'
                  ? 'hourglass-outline'
                : runtimeState === 'partial' || runtimeState === 'error'
                  ? 'warning-outline'
                  : 'navigate-outline'
        }
        size={compact ? 20 : 16}
        color={
          disabled
            ? theme.colors.textMuted
            : managedRunning
              ? theme.colors.statusError
              : theme.colors.statusConnected
        }
      />
      {!compact && (
        <Text style={[styles.text, managedRunning && styles.stopText]}>
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
  runningButton: {
    borderColor: theme.colors.statusConnected + '88',
    backgroundColor: theme.colors.statusConnected + '16',
  },
  stopButton: {
    borderColor: theme.colors.statusError + '88',
    backgroundColor: theme.colors.statusErrorGlow,
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
  stopText: {
    color: theme.colors.statusError,
  },
});
