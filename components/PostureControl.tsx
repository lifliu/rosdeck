import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation, type TranslationKey } from '../lib/i18n';
import { useRosStore } from '../stores/useRosStore';
import { CONTROL_CLIENT_ID } from '../lib/control-authority';
import { useControlAuthorityStore } from '../stores/useControlAuthorityStore';

export const POSTURE_COMMAND_TOPIC = '/rosdeck/posture_command';
export const POSTURE_STATUS_TOPIC = '/rosdeck/posture_status';
export const POSTURE_MESSAGE_TYPE = 'std_msgs/msg/String';
export const POSTURE_COMMANDS = {
  stand: { data: 'stand' },
  lieDown: { data: 'lie_down' },
} as const;

export function buildPostureCommand(command: PostureCommand) {
  return { data: `${POSTURE_COMMANDS[command].data}:${CONTROL_CLIENT_ID}` };
}

export type PostureCommand = keyof typeof POSTURE_COMMANDS;

const ACK_TIMEOUT_MS = 10000;

export function parsePostureStatus(message: any) {
  if (typeof message?.data !== 'string') return null;
  const [result, command, ...details] = message.data.split(':');
  if ((result !== 'success' && result !== 'error') || !command) return null;
  return { result, command, details: details.join(':') };
}

export function PostureControl({ compact = false }: { compact?: boolean }) {
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const authorityStatus = useControlAuthorityStore((state) => state.status);
  const authorityOwner = useControlAuthorityStore((state) => state.ownerId);
  const [pending, setPending] = useState<PostureCommand | null>(null);
  const pendingRef = useRef<PostureCommand | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    if (status !== 'connected' || !transport || url?.startsWith('demo://')) return;
    const subscription = transport.subscribe(
      POSTURE_STATUS_TOPIC,
      POSTURE_MESSAGE_TYPE,
      (message) => {
        const parsed = parsePostureStatus(message);
        const expected = pendingRef.current;
        if (!parsed || !expected || parsed.command !== POSTURE_COMMANDS[expected].data) return;

        clearTimeoutRef();
        pendingRef.current = null;
        setPending(null);
        if (parsed.result === 'success') {
          Alert.alert(
            t('posture.successTitle'),
            t(`posture.${expected}Success` as TranslationKey),
          );
        } else {
          Alert.alert(
            t('posture.failedTitle'),
            t('posture.error', { message: parsed.details || 'unknown_error' }),
          );
        }
      },
    );
    return () => subscription.unsubscribe();
  }, [status, transport, url, clearTimeoutRef, t]);

  useEffect(() => () => clearTimeoutRef(), [clearTimeoutRef]);

  const sendCommand = useCallback((command: PostureCommand) => {
    if (status !== 'connected' || !transport || url?.startsWith('demo://')) {
      Alert.alert(t('posture.failedTitle'), t('posture.disconnected'));
      return;
    }
    pendingRef.current = command;
    setPending(command);
    transport.publish(
      POSTURE_COMMAND_TOPIC,
      POSTURE_MESSAGE_TYPE,
      buildPostureCommand(command),
    );
    clearTimeoutRef();
    timeoutRef.current = setTimeout(() => {
      pendingRef.current = null;
      setPending(null);
      Alert.alert(t('posture.failedTitle'), t('posture.bridgeMissing'));
    }, ACK_TIMEOUT_MS);
  }, [status, transport, url, clearTimeoutRef, t]);

  const confirmCommand = useCallback((command: PostureCommand) => {
    Alert.alert(
      t(`posture.${command}ConfirmTitle` as TranslationKey),
      t(`posture.${command}ConfirmMessage` as TranslationKey),
      [
        { text: t('posture.cancel'), style: 'cancel' },
        {
          text: t(`posture.${command}Button` as TranslationKey),
          onPress: () => sendCommand(command),
        },
      ],
    );
  }, [sendCommand, t]);

  const authorityReady = authorityStatus === 'unsupported' ||
    (authorityStatus === 'acquired' && authorityOwner === CONTROL_CLIENT_ID);
  const disabled = status !== 'connected' || !transport || url?.startsWith('demo://') ||
    !authorityReady || pending !== null;

  return (
    <View style={styles.container}>
      <PostureButton
        compact={compact}
        disabled={disabled}
        waiting={pending === 'stand'}
        icon="arrow-up-circle-outline"
        label={t('posture.standButton')}
        onPress={() => confirmCommand('stand')}
      />
      <PostureButton
        compact={compact}
        disabled={disabled}
        waiting={pending === 'lieDown'}
        icon="arrow-down-circle-outline"
        label={t('posture.lieDownButton')}
        onPress={() => confirmCommand('lieDown')}
      />
    </View>
  );
}

function PostureButton({ compact, disabled, waiting, icon, label, onPress }: {
  compact: boolean;
  disabled: boolean;
  waiting: boolean;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.button, compact && styles.compactButton, disabled && styles.disabled]}
      disabled={disabled}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Ionicons
        name={waiting ? 'hourglass-outline' : icon}
        size={compact ? 20 : 16}
        color={disabled ? theme.colors.textMuted : theme.colors.statusConnected}
      />
      {!compact && <Text style={styles.text}>{label}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
  },
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
});
