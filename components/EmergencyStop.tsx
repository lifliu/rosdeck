import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation } from '../lib/i18n';
import { useRosStore } from '../stores/useRosStore';
import type { TwistMessage } from '../types/ros';

const E_STOP_TOPIC = '/rosdeck/emergency_stop';
const E_STOP_MESSAGE_TYPE = 'std_msgs/msg/Bool';
const E_STOP_MESSAGE = { data: true } as const;

/** Common cmd_vel topic names to publish zero-velocity to for emergency stop. */
const CMD_VEL_TOPICS = ['/cmd_vel', '/robot/cmd_vel', '/diff_drive/cmd_vel'];

/**
 * Build a zero-velocity Twist message for emergency stop.
 */
function zeroTwist(): TwistMessage {
  return { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } };
}

export function EmergencyStop({ compact = false }: { compact?: boolean }) {
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);

  const disabled = status !== 'connected' || !transport || url?.startsWith('demo://');

  const sendEStop = useCallback(() => {
    if (!transport || disabled) return;

    // Publish zero-velocity Twist to all known cmd_vel topics
    const twist = zeroTwist();
    for (const topic of CMD_VEL_TOPICS) {
      transport.publish(topic, 'geometry_msgs/msg/Twist', twist);
    }

    // Also publish to the bridge e-stop command topic
    transport.publish(E_STOP_TOPIC, E_STOP_MESSAGE_TYPE, E_STOP_MESSAGE);

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