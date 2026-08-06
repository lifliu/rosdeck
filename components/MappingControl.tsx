import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation } from '../lib/i18n';
import { useRosStore } from '../stores/useRosStore';

export const START_MAPPING_TOPIC = '/rosdeck/start_3d_mapping';
export const MAPPING_STATUS_TOPIC = '/rosdeck/mapping_status';
export const START_MAPPING_MESSAGE_TYPE = 'std_msgs/msg/Bool';
export const START_MAPPING_MESSAGE = { data: true } as const;
export const STOP_MAPPING_MESSAGE = { data: false } as const;

const ACK_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 60000;
type PendingCommand = 'start' | 'stop';

export function extractMappingStatus(message: any): string {
  return typeof message?.data === 'string' ? message.data : '';
}

export function MappingControl({ compact = false }: { compact?: boolean }) {
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const [waiting, setWaiting] = useState(false);
  const [isMapping, setIsMapping] = useState(false);
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
      setIsMapping(false);
      clearAckTimeout();
      return;
    }

    const subscription = transport.subscribe(
      MAPPING_STATUS_TOPIC,
      'std_msgs/msg/String',
      (message) => {
        const mappingStatus = extractMappingStatus(message);
        if (!mappingStatus) return;

        if (mappingStatus.startsWith('started:') || mappingStatus === 'already_running') {
          setIsMapping(true);
          if (pendingRef.current === 'start') {
            pendingRef.current = null;
            clearAckTimeout();
            setWaiting(false);
            Alert.alert(t('mapping.startedTitle'), t('mapping.startedMessage'));
          }
        } else if (mappingStatus.startsWith('stopping:')) {
          setIsMapping(true);
        } else if (mappingStatus.startsWith('stopped:')) {
          setIsMapping(false);
          if (pendingRef.current === 'stop') {
            pendingRef.current = null;
            clearAckTimeout();
            setWaiting(false);
            Alert.alert(t('mapping.stoppedTitle'), t('mapping.stoppedMessage'));
          }
        } else if (mappingStatus.startsWith('exited:') || mappingStatus === 'not_running') {
          const command = pendingRef.current;
          setIsMapping(false);
          if (command) {
            pendingRef.current = null;
            clearAckTimeout();
            setWaiting(false);
            Alert.alert(
              t(command === 'stop' ? 'mapping.stopFailedTitle' : 'mapping.failedTitle'),
              t('mapping.error', { message: mappingStatus }),
            );
          }
        } else if (mappingStatus.startsWith('error:')) {
          const command = pendingRef.current;
          pendingRef.current = null;
          clearAckTimeout();
          setWaiting(false);
          Alert.alert(
            t(command === 'stop' ? 'mapping.stopFailedTitle' : 'mapping.failedTitle'),
            t('mapping.error', { message: mappingStatus.slice('error:'.length) }),
          );
        }
      },
    );

    return () => subscription.unsubscribe();
  }, [status, transport, url, clearAckTimeout, t]);

  useEffect(() => () => clearAckTimeout(), [clearAckTimeout]);

  const sendRequest = useCallback((command: PendingCommand) => {
    if (status !== 'connected' || !transport || url?.startsWith('demo://')) {
      Alert.alert(t('mapping.failedTitle'), t('mapping.disconnected'));
      return;
    }

    setWaiting(true);
    pendingRef.current = command;
    transport.publish(
      START_MAPPING_TOPIC,
      START_MAPPING_MESSAGE_TYPE,
      command === 'start' ? START_MAPPING_MESSAGE : STOP_MAPPING_MESSAGE,
    );
    clearAckTimeout();
    timeoutRef.current = setTimeout(() => {
      pendingRef.current = null;
      setWaiting(false);
      Alert.alert(
        t(command === 'stop' ? 'mapping.stopFailedTitle' : 'mapping.failedTitle'),
        t('mapping.bridgeMissing'),
      );
    }, command === 'stop' ? STOP_TIMEOUT_MS : ACK_TIMEOUT_MS);
  }, [status, transport, url, clearAckTimeout, t]);

  const confirmCommand = useCallback(() => {
    const command: PendingCommand = isMapping ? 'stop' : 'start';
    Alert.alert(
      t(isMapping ? 'mapping.stopConfirmTitle' : 'mapping.confirmTitle'),
      t(isMapping ? 'mapping.stopConfirmMessage' : 'mapping.confirmMessage'),
      [
        { text: t('mapping.cancel'), style: 'cancel' },
        {
          text: t(isMapping ? 'mapping.stop' : 'mapping.start'),
          style: isMapping ? 'destructive' : 'default',
          onPress: () => sendRequest(command),
        },
      ],
    );
  }, [isMapping, sendRequest, t]);

  const disabled = status !== 'connected' || !transport || url?.startsWith('demo://') || waiting;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t(isMapping ? 'mapping.stopButton' : 'mapping.button')}
      style={[
        styles.button,
        isMapping && styles.stopButton,
        compact && styles.compactButton,
        disabled && styles.disabled,
      ]}
      disabled={disabled}
      onPress={confirmCommand}
      activeOpacity={0.75}
    >
      <Ionicons
        name={waiting ? 'hourglass-outline' : isMapping ? 'stop-circle-outline' : 'cube-outline'}
        size={compact ? 20 : 16}
        color={
          disabled
            ? theme.colors.textMuted
            : isMapping
              ? theme.colors.statusError
              : theme.colors.accentPrimary
        }
      />
      {!compact && (
        <Text style={[styles.text, isMapping && styles.stopText]}>
          {t(isMapping ? 'mapping.stopButton' : 'mapping.button')}
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
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.accentPrimary,
  },
  stopText: {
    color: theme.colors.statusError,
  },
});
