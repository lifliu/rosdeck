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

const ACK_TIMEOUT_MS = 5000;

export function extractMappingStatus(message: any): string {
  return typeof message?.data === 'string' ? message.data : '';
}

export function MappingControl({ compact = false }: { compact?: boolean }) {
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const [waiting, setWaiting] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingRef = useRef(false);

  const clearAckTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  useEffect(() => {
    waitingRef.current = waiting;
  }, [waiting]);

  useEffect(() => {
    if (status !== 'connected' || !transport || url?.startsWith('demo://')) return;

    const subscription = transport.subscribe(
      MAPPING_STATUS_TOPIC,
      'std_msgs/msg/String',
      (message) => {
        const mappingStatus = extractMappingStatus(message);
        if (!waitingRef.current || !mappingStatus) return;

        if (mappingStatus.startsWith('started:') || mappingStatus === 'already_running') {
          clearAckTimeout();
          setWaiting(false);
          Alert.alert(t('mapping.startedTitle'), t('mapping.startedMessage'));
        } else if (mappingStatus.startsWith('error:')) {
          clearAckTimeout();
          setWaiting(false);
          Alert.alert(
            t('mapping.failedTitle'),
            t('mapping.error', { message: mappingStatus.slice('error:'.length) }),
          );
        }
      },
    );

    return () => subscription.unsubscribe();
  }, [status, transport, url, clearAckTimeout, t]);

  useEffect(() => () => clearAckTimeout(), [clearAckTimeout]);

  const sendStartRequest = useCallback(() => {
    if (status !== 'connected' || !transport || url?.startsWith('demo://')) {
      Alert.alert(t('mapping.failedTitle'), t('mapping.disconnected'));
      return;
    }

    setWaiting(true);
    waitingRef.current = true;
    transport.publish(START_MAPPING_TOPIC, START_MAPPING_MESSAGE_TYPE, START_MAPPING_MESSAGE);
    clearAckTimeout();
    timeoutRef.current = setTimeout(() => {
      waitingRef.current = false;
      setWaiting(false);
      Alert.alert(t('mapping.failedTitle'), t('mapping.bridgeMissing'));
    }, ACK_TIMEOUT_MS);
  }, [status, transport, url, clearAckTimeout, t]);

  const confirmStart = useCallback(() => {
    Alert.alert(t('mapping.confirmTitle'), t('mapping.confirmMessage'), [
      { text: t('mapping.cancel'), style: 'cancel' },
      { text: t('mapping.start'), onPress: sendStartRequest },
    ]);
  }, [sendStartRequest, t]);

  const disabled = status !== 'connected' || !transport || url?.startsWith('demo://') || waiting;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t('mapping.button')}
      style={[styles.button, compact && styles.compactButton, disabled && styles.disabled]}
      disabled={disabled}
      onPress={confirmStart}
      activeOpacity={0.75}
    >
      <Ionicons
        name={waiting ? 'hourglass-outline' : 'cube-outline'}
        size={compact ? 20 : 16}
        color={disabled ? theme.colors.textMuted : theme.colors.accentPrimary}
      />
      {!compact && <Text style={styles.text}>{t('mapping.button')}</Text>}
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
});
