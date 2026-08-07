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
export const START_NAVIGATION_MODE_TYPE = 'std_msgs/msg/String';
/** 'localize' for localization-only (uses existing map), 'navigate' for full navigation with map */
export const NAVIGATION_MODE_COMMANDS = {
  localize: { data: 'localize' },
  navigate: { data: 'navigate' },
} as const;

export type NavigationMode = keyof typeof NAVIGATION_MODE_COMMANDS;

const ACK_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 60000;
type PendingCommand = 'start' | 'stop';

export function extractNavigationStatus(message: any): string {
  return typeof message?.data === 'string' ? message.data : '';
}

export function NavigationControl({ compact = false }: { compact?: boolean }) {
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const [waiting, setWaiting] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [mode, setMode] = useState<NavigationMode>('navigate');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PendingCommand | null>(null);

  const clearAckTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  useEffect(() => {
    if (status !== 'connected' || !transport || url?.startsWith('demo://')) {
      pendingRef.current = null;
      setWaiting(false);
      setIsNavigating(false);
      clearAckTimeout();
      return;
    }

    const subscription = transport.subscribe(
      NAVIGATION_STATUS_TOPIC,
      'std_msgs/msg/String',
      (message) => {
        const navStatus = extractNavigationStatus(message);
        if (!navStatus) return;

        if (navStatus.startsWith('started:') || navStatus === 'already_running') {
          setIsNavigating(true);
          if (pendingRef.current === 'start') {
            pendingRef.current = null;
            clearAckTimeout();
            setWaiting(false);
            Alert.alert(t('navigation.startedTitle'), t('navigation.startedMessage'));
          }
        } else if (navStatus.startsWith('stopping:')) {
          // navigation is stopping, keep UI in navigating state
        } else if (navStatus.startsWith('stopped:')) {
          setIsNavigating(false);
          if (pendingRef.current === 'stop') {
            pendingRef.current = null;
            clearAckTimeout();
            setWaiting(false);
            Alert.alert(t('navigation.stoppedTitle'), t('navigation.stoppedMessage'));
          }
        } else if (navStatus.startsWith('exited:') || navStatus === 'not_running') {
          const command = pendingRef.current;
          setIsNavigating(false);
          if (command) {
            pendingRef.current = null;
            clearAckTimeout();
            setWaiting(false);
            Alert.alert(
              t(command === 'stop' ? 'navigation.stopFailedTitle' : 'navigation.failedTitle'),
              t('navigation.error', { message: navStatus }),
            );
          }
        } else if (navStatus.startsWith('error:')) {
          const command = pendingRef.current;
          pendingRef.current = null;
          clearAckTimeout();
          setWaiting(false);
          Alert.alert(
            t(command === 'stop' ? 'navigation.stopFailedTitle' : 'navigation.failedTitle'),
            t('navigation.error', { message: navStatus.slice('error:'.length) }),
          );
        }
      },
    );

    return () => subscription.unsubscribe();
  }, [status, transport, url, clearAckTimeout, t]);

  useEffect(() => () => clearAckTimeout(), [clearAckTimeout]);

  const sendRequest = useCallback((command: PendingCommand) => {
    if (!transport || status !== 'connected' || url?.startsWith('demo://')) {
      Alert.alert(t('navigation.failedTitle'), t('navigation.disconnected'));
      return;
    }

    setWaiting(true);
    pendingRef.current = command;

    // Send Bool for start/stop signal
    transport.publish(
      START_NAVIGATION_TOPIC,
      NAVIGATION_MESSAGE_TYPE,
      command === 'start' ? START_NAVIGATION_MESSAGE : STOP_NAVIGATION_MESSAGE,
    );

    // If starting, also send the mode command
    if (command === 'start') {
      transport.publish(
        START_NAVIGATION_TOPIC,
        START_NAVIGATION_MODE_TYPE,
        NAVIGATION_MODE_COMMANDS[mode],
      );
    }

    clearAckTimeout();
    timeoutRef.current = setTimeout(() => {
      pendingRef.current = null;
      setWaiting(false);
      Alert.alert(
        t(command === 'stop' ? 'navigation.stopFailedTitle' : 'navigation.failedTitle'),
        t('navigation.bridgeMissing'),
      );
    }, command === 'stop' ? STOP_TIMEOUT_MS : ACK_TIMEOUT_MS);
  }, [status, transport, url, mode, clearAckTimeout, t]);

  const confirmCommand = useCallback(() => {
    const command: PendingCommand = isNavigating ? 'stop' : 'start';
    Alert.alert(
      t(isNavigating ? 'navigation.stopConfirmTitle' : 'navigation.confirmTitle'),
      t(isNavigating ? 'navigation.stopConfirmMessage' : 'navigation.confirmMessage'),
      [
        { text: t('navigation.cancel'), style: 'cancel' },
        {
          text: t(isNavigating ? 'navigation.stop' : 'navigation.start'),
          style: isNavigating ? 'destructive' : 'default',
          onPress: () => sendRequest(command),
        },
      ],
    );
  }, [isNavigating, sendRequest, t]);

  const disabled = status !== 'connected' || !transport || url?.startsWith('demo://') || waiting;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t(isNavigating ? 'navigation.stopButton' : 'navigation.button')}
      style={[
        styles.button,
        isNavigating && styles.stopButton,
        compact && styles.compactButton,
        disabled && styles.disabled,
      ]}
      disabled={disabled}
      onPress={confirmCommand}
      activeOpacity={0.75}
    >
      <Ionicons
        name={
          waiting
            ? 'hourglass-outline'
            : isNavigating
              ? 'navigate'
              : 'navigate-outline'
        }
        size={compact ? 20 : 16}
        color={
          disabled
            ? theme.colors.textMuted
            : isNavigating
              ? theme.colors.statusError
              : theme.colors.statusConnected
        }
      />
      {!compact && (
        <Text style={[styles.text, isNavigating && styles.stopText]}>
          {t(isNavigating ? 'navigation.stopButton' : 'navigation.button')}
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
    minHeight: 34,
    paddingHorizontal: 12,
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
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.statusConnected,
  },
  stopText: {
    color: theme.colors.statusError,
  },
});