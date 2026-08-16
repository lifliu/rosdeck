import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation } from '../lib/i18n';
import type { Transport } from '../lib/transport';
import { useRosStore } from '../stores/useRosStore';

/**
 * The canonical request is consumed by the safety supervisor/velocity arbiter.
 * The posture command remains as a VBot compatibility path for safe laydown.
 */
export const EMERGENCY_STOP_REQUEST_TOPIC = '/omni/safety/estop_request';
export const EMERGENCY_STOP_REQUEST_MESSAGE_TYPE = 'std_msgs/msg/Bool';
export const EMERGENCY_STOP_REQUEST_MESSAGE = { data: true } as const;
export const VBOT_EMERGENCY_STOP_TOPIC = '/rosdeck/posture_command';
export const VBOT_EMERGENCY_STOP_MESSAGE_TYPE = 'std_msgs/msg/String';
export const VBOT_EMERGENCY_STOP_MESSAGE = { data: 'emergency_stop' } as const;

export function publishEmergencyStop(transport: Pick<Transport, 'publish'>): void {
  // Publish the fail-safe request first. The arbiter owns all velocity outputs;
  // the App must never bypass it by writing to arbitrary cmd_vel topics.
  transport.publish(
    EMERGENCY_STOP_REQUEST_TOPIC,
    EMERGENCY_STOP_REQUEST_MESSAGE_TYPE,
    EMERGENCY_STOP_REQUEST_MESSAGE,
  );
  transport.publish(
    VBOT_EMERGENCY_STOP_TOPIC,
    VBOT_EMERGENCY_STOP_MESSAGE_TYPE,
    VBOT_EMERGENCY_STOP_MESSAGE,
  );
}

export function emergencyStopIsEnabled(
  connectionStatus: string,
  transport: Pick<Transport, 'publish'> | null,
  url: string | null | undefined,
): boolean {
  return connectionStatus === 'connected' && Boolean(transport) && !url?.startsWith('demo://');
}

export function EmergencyStop({ compact = false }: { compact?: boolean }) {
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);

  const disabled = !emergencyStopIsEnabled(status, transport, url);

  const sendEStop = useCallback(() => {
    if (!transport || disabled) return;
    publishEmergencyStop(transport);

    // Brief visual feedback
    setPressed(true);
    setTimeout(() => setPressed(false), 600);
  }, [transport, disabled]);

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t('estop.button')}
      style={[
        styles.button,
        pressed && styles.pressed,
        compact && styles.compactButton,
        disabled && styles.disabled,
      ]}
      disabled={disabled}
      onPress={sendEStop}
      activeOpacity={0.6}
    >
      <Ionicons
        name={pressed ? 'checkmark-circle' : 'stop-circle-outline'}
        size={compact ? 20 : 16}
        color={
          disabled
            ? theme.colors.textMuted
            : pressed
              ? theme.colors.statusConnected
              : theme.colors.statusError
        }
      />
      {!compact && (
        <Text style={[styles.text, pressed && styles.pressedText]}>
          {t('estop.button')}
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
    borderColor: theme.colors.statusError + '88',
    backgroundColor: theme.colors.statusError + '15',
  },
  compactButton: {
    width: 40,
    height: 40,
    minHeight: 40,
    paddingHorizontal: 0,
  },
  pressed: {
    borderColor: theme.colors.statusConnected,
    backgroundColor: theme.colors.statusConnected + '22',
  },
  disabled: {
    opacity: 0.35,
    borderColor: theme.colors.borderDefault,
    backgroundColor: theme.colors.bgSurface,
  },
  text: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.statusError,
  },
  pressedText: {
    color: theme.colors.statusConnected,
  },
});
