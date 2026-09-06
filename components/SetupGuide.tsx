import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import { useSettingsStore } from '../stores/useSettingsStore';

interface Props {
  visible: boolean;
  onClose: () => void;
  onTryDemo?: () => void;
}

export function SetupGuide({ visible, onClose, onTryDemo }: Props) {
  const language = useSettingsStore((s) => s.language);
  const zh = language === 'zh';
  const [showCommands, setShowCommands] = useState(false);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerIcon}><Ionicons name="git-network-outline" size={23} color={theme.colors.accentPrimary} /></View>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>{zh ? '连接机器人' : 'Connect your robot'}</Text>
              <Text style={styles.subtitle}>{zh ? '手机和机器人需要连接到同一网络' : 'Your phone and robot must share a network'}</Text>
            </View>
            <TouchableOpacity style={styles.close} onPress={onClose}><Ionicons name="close" size={21} color={theme.colors.textSecondary} /></TouchableOpacity>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionTitle}>{zh ? '连接步骤' : 'Connection steps'}</Text>
            <GuideStep number="1" title={zh ? '确认网络' : 'Check the network'} message={zh ? '将手机连接到机器人所在的 Wi-Fi 或安全局域网。' : 'Join the Wi-Fi or secure local network used by the robot.'} />
            <GuideStep number="2" title={zh ? '启动机器人网关' : 'Start a robot gateway'} message={zh ? '推荐使用 Foxglove Bridge；已有系统也可以继续使用 Rosbridge。' : 'Foxglove Bridge is recommended. Existing Rosbridge deployments remain supported.'} />
            <GuideStep number="3" title={zh ? '输入地址并连接' : 'Enter the address'} message={zh ? '输入 IP 和端口，APP 会探测并选择可用协议。' : 'Enter the IP and port. OmniDeck probes and selects the available protocol.'} />

            <Text style={styles.sectionTitle}>{zh ? '支持的网关' : 'Supported gateways'}</Text>
            <View style={styles.gatewayRow}>
              <View style={[styles.gateway, styles.gatewayRecommended]}>
                <View style={styles.gatewayTop}><Text style={styles.gatewayName}>Foxglove</Text><Text style={styles.recommended}>{zh ? '推荐' : 'RECOMMENDED'}</Text></View>
                <Text style={styles.gatewayMeta}>{zh ? '二进制传输 · 端口 8765' : 'Binary transport · port 8765'}</Text>
              </View>
              <View style={styles.gateway}>
                <Text style={styles.gatewayName}>Rosbridge</Text>
                <Text style={styles.gatewayMeta}>{zh ? 'JSON 传输 · 端口 9090' : 'JSON transport · port 9090'}</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.advancedToggle} onPress={() => setShowCommands((value) => !value)}>
              <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
              <Text style={styles.advancedText}>{zh ? '机器人端部署命令' : 'Robot-side setup commands'}</Text>
              <Ionicons name={showCommands ? 'chevron-up' : 'chevron-down'} size={17} color={theme.colors.textMuted} />
            </TouchableOpacity>
            {showCommands ? (
              <View style={styles.codeBlock}>
                <Text style={styles.codeLabel}>FOXGLOVE BRIDGE</Text>
                <Text selectable style={styles.code}>sudo apt install ros-$ROS_DISTRO-foxglove-bridge</Text>
                <Text selectable style={styles.code}>ros2 launch foxglove_bridge foxglove_bridge_launch.xml</Text>
                <View style={styles.codeDivider} />
                <Text style={styles.codeLabel}>ROSBRIDGE</Text>
                <Text selectable style={styles.code}>sudo apt install ros-$ROS_DISTRO-rosbridge-suite</Text>
                <Text selectable style={styles.code}>ros2 launch rosbridge_server rosbridge_websocket_launch.xml</Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            {onTryDemo ? <TouchableOpacity style={[styles.button, styles.secondaryButton]} onPress={onTryDemo}><Ionicons name="play" size={18} color={theme.colors.statusConnecting} /><Text style={styles.secondaryText}>{zh ? '体验演示' : 'Try demo'}</Text></TouchableOpacity> : null}
            <TouchableOpacity style={[styles.button, styles.primaryButton]} onPress={onClose}><Text style={styles.primaryText}>{zh ? '我知道了' : 'Got it'}</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function GuideStep({ number, title, message }: { number: string; title: string; message: string }) {
  return <View style={styles.step}><View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View><View style={styles.stepCopy}><Text style={styles.stepTitle}>{title}</Text><Text style={styles.stepMessage}>{message}</Text></View></View>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#000000A6' },
  sheet: { maxHeight: '90%', backgroundColor: theme.colors.bgElevated, borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, borderWidth: 1, borderBottomWidth: 0, borderColor: theme.colors.borderDefault },
  handle: { width: 42, height: 4, borderRadius: 2, backgroundColor: theme.colors.borderDefault, alignSelf: 'center', marginTop: 9 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 15, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  headerIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentPrimaryMuted },
  headerCopy: { flex: 1 },
  title: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  subtitle: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 2 },
  close: { width: 42, height: 42, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgSurface },
  scroll: { flexShrink: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 20 },
  sectionTitle: { ...theme.typography.headingSm, color: theme.colors.textPrimary, marginTop: 20, marginBottom: 11 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 15 },
  stepNumber: { width: 30, height: 30, borderRadius: 15, backgroundColor: theme.colors.accentPrimaryMuted, alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { fontSize: 13, fontWeight: '700', color: theme.colors.accentPrimary },
  stepCopy: { flex: 1 },
  stepTitle: { fontSize: 14, fontWeight: '600', color: theme.colors.textPrimary },
  stepMessage: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 3 },
  gatewayRow: { flexDirection: 'row', gap: 10 },
  gateway: { flex: 1, minHeight: 94, padding: 13, borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSurface, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  gatewayRecommended: { borderColor: theme.colors.accentPrimary + '66' },
  gatewayTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  gatewayName: { fontSize: 14, fontWeight: '600', color: theme.colors.textPrimary },
  gatewayMeta: { fontSize: 12, lineHeight: 17, color: theme.colors.textMuted, marginTop: 9 },
  recommended: { fontSize: 8, color: theme.colors.accentPrimary, fontWeight: '700' },
  advancedToggle: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, paddingHorizontal: 13, borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSurface },
  advancedText: { flex: 1, fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary },
  codeBlock: { marginTop: 8, padding: 13, borderRadius: theme.radius.md, backgroundColor: theme.colors.bgInset, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  codeLabel: { ...theme.typography.monoXs, color: theme.colors.textMuted, marginBottom: 5 },
  code: { ...theme.typography.monoXs, color: theme.colors.statusConnected, marginBottom: 5 },
  codeDivider: { height: 1, backgroundColor: theme.colors.borderSubtle, marginVertical: 9 },
  footer: { flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle },
  button: { flex: 1, minHeight: 48, borderRadius: theme.radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1 },
  secondaryButton: { borderColor: theme.colors.statusConnecting + '66', backgroundColor: theme.colors.statusConnectingGlow },
  primaryButton: { borderColor: theme.colors.accentPrimary, backgroundColor: theme.colors.accentPrimary },
  secondaryText: { fontSize: 14, fontWeight: '700', color: theme.colors.statusConnecting },
  primaryText: { fontSize: 14, fontWeight: '700', color: theme.colors.bgBase },
});
