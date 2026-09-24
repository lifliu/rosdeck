import React, { useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import { useRosStore } from '../stores/useRosStore';
import { steppedTravelSpeed, useTravelSpeedStore } from '../stores/useTravelSpeedStore';

/** One subscription per connection; the robot owns this setting across screens. */
export function TravelSpeedSession() {
  const transport = useRosStore((s) => s.transport);
  const connected = useRosStore((s) => s.connection.status === 'connected');
  useEffect(() => {
    useTravelSpeedStore.getState().reset();
    if (!connected || !transport) return;
    let active = true;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const sub = transport.subscribe('/omni/control/travel_speed', 'std_msgs/msg/Float64', (message) => {
      if (!active || typeof message?.data !== 'number' || !Number.isFinite(message.data) ||
        message.data < 0.1 || message.data > 1.5) return;
      useTravelSpeedStore.getState().apply(message.data);
      clearTimeout(expiry);
      expiry = setTimeout(() => useTravelSpeedStore.setState({ known: false }), 2000);
    });
    return () => { active = false; clearTimeout(expiry); sub.unsubscribe(); };
  }, [transport, connected]);
  return null;
}

export function TravelSpeedControl() {
  const { speed, known, pending, error } = useTravelSpeedStore();
  const transport = useRosStore((s) => s.transport);
  const connected = useRosStore((s) => s.connection.status === 'connected');
  const change = async (direction: -1 | 1) => {
    const current = useTravelSpeedStore.getState();
    if (!transport || !connected || !current.known || current.pending) return;
    useTravelSpeedStore.setState({ pending: true, error: null });
    try {
      const reply = await transport.callService('/omni/control/set_travel_speed',
        'omni_robot_interfaces/srv/SetTravelSpeed',
        { speed_mps: steppedTravelSpeed(current.speed, direction) }, { timeoutMs: 2000 });
      if (useRosStore.getState().transport !== transport || transport.getStatus() !== 'connected') return;
      if (!reply?.accepted) throw new Error(reply?.reason || '速度设置失败');
      useTravelSpeedStore.getState().apply(Number(reply.speed_mps ?? reply.speedMps));
    } catch (e: any) {
      if (useRosStore.getState().transport === transport) {
        useTravelSpeedStore.setState({ error: e?.message || '速度设置失败' });
      }
    } finally {
      if (useRosStore.getState().transport === transport) useTravelSpeedStore.setState({ pending: false });
    }
  };
  const disabled = !known || !connected || pending;
  return <View>
    <View style={styles.row}>
      <TouchableOpacity accessibilityLabel="降低速度" disabled={disabled || speed <= 0.1}
        style={[styles.button, (disabled || speed <= 0.1) && styles.disabled]} onPress={() => void change(-1)}>
        <Text style={styles.symbol}>−</Text>
      </TouchableOpacity>
      <Text style={styles.value}>{known ? speed.toFixed(1) : '—'} m/s</Text>
      <TouchableOpacity accessibilityLabel="增加速度" disabled={disabled || speed >= 1.5}
        style={[styles.button, (disabled || speed >= 1.5) && styles.disabled]} onPress={() => void change(1)}>
        <Text style={styles.symbol}>+</Text>
      </TouchableOpacity>
    </View>
    {error ? <Text style={styles.error}>{error}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.colors.accentPrimary },
  symbol: { fontSize: 26, color: '#071318' },
  value: { color: theme.colors.textPrimary, fontSize: 16, minWidth: 70, textAlign: 'center' },
  disabled: { opacity: 0.35 },
  error: { color: '#ff7272', fontSize: 12, maxWidth: 220 },
});
