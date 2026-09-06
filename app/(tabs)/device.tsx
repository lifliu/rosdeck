import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConnectionForm } from '../../components/ConnectionForm';
import { ProductButton, ProductCard, ProductHeader, SectionHeader, StatusPill } from '../../components/ProductUI';
import { SavedConnections } from '../../components/SavedConnections';
import { SetupGuide } from '../../components/SetupGuide';
import { theme } from '../../constants/theme';
import { useOrientation } from '../../hooks/useOrientation';
import { useProductCopy } from '../../lib/product-copy';
import { useOnboardingStore } from '../../stores/useOnboardingStore';
import { useRosStore } from '../../stores/useRosStore';

function displayHost(url: string): string {
  if (url.startsWith('demo://')) return 'Omni Scout · Demo';
  try { return new URL(url).hostname; } catch { return url; }
}

export default function DeviceScreen() {
  const router = useRouter();
  const { pc } = useProductCopy();
  const { isLandscape } = useOrientation();
  const connection = useRosStore((s) => s.connection);
  const transportType = useRosStore((s) => s.transportType);
  const disconnect = useRosStore((s) => s.disconnect);
  const [showGuide, setShowGuide] = useState(false);
  const connected = connection.status === 'connected';
  const demo = connection.url.startsWith('demo://');

  const openDemo = () => {
    useRosStore.getState().setTransportType('demo');
    useRosStore.getState().connectToUrl('demo://localhost');
    useOnboardingStore.getState().setHasUsedDemo();
    router.push('/(tabs)');
  };

  const selectSaved = (url: string) => {
    const saved = useRosStore.getState().savedConnections.find((item) => item.url === url);
    if (saved?.transport) useRosStore.getState().setTransportType(saved.transport);
    useRosStore.getState().connectToUrl(url);
    router.push('/(tabs)/control');
  };

  return (
    <SafeAreaView style={styles.safe} edges={isLandscape ? [] : ['top']}>
      <ProductHeader
        title={pc('device.title')}
        subtitle={pc('device.subtitle')}
        trailing={(
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={pc('device.guide')} style={styles.helpButton} onPress={() => setShowGuide(true)}>
            <Ionicons name="help-circle-outline" size={22} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      />
      <ScrollView contentContainerStyle={[styles.content, isLandscape && styles.landscapeContent]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={[styles.columns, isLandscape && styles.columnsLandscape]}>
          <View style={styles.column}>
            {connected ? (
              <>
                <SectionHeader title={pc('device.active')} />
                <ProductCard emphasized>
                  <View style={styles.activeTop}>
                    <View style={styles.deviceIcon}><Ionicons name="hardware-chip" size={24} color={theme.colors.accentPrimary} /></View>
                    <View style={styles.activeCopy}>
                      <Text style={styles.deviceName}>{displayHost(connection.url)}</Text>
                      <Text style={styles.deviceAddress} numberOfLines={1}>{connection.url}</Text>
                    </View>
                    <StatusPill label={demo ? 'DEMO' : 'ONLINE'} tone={demo ? 'warning' : 'success'} />
                  </View>
                  <View style={styles.connectionDetail}>
                    <Ionicons name="git-network-outline" size={17} color={theme.colors.textMuted} />
                    <Text style={styles.connectionDetailText}>{pc('device.connectedVia', { transport: transportType === 'foxglove' ? 'Foxglove' : demo ? 'Demo' : 'Rosbridge' })}</Text>
                  </View>
                  <ProductButton label={pc('device.disconnect')} icon="power-outline" variant="danger" onPress={disconnect} />
                </ProductCard>
              </>
            ) : null}

            <SectionHeader title={pc('device.add')} />
            <Text style={styles.sectionHint}>{pc('device.addHint')}</Text>
            <ProductCard style={styles.formCard}>
              <ConnectionForm />
            </ProductCard>
          </View>

          <View style={styles.column}>
            <SectionHeader title={pc('device.demo')} />
            <ProductCard>
              <View style={styles.demoTop}>
                <View style={styles.demoIllustration}>
                  <Ionicons name="scan-outline" size={30} color={theme.colors.statusConnecting} />
                </View>
                <View style={styles.demoCopy}>
                  <Text style={styles.demoTitle}>{pc('device.demo')}</Text>
                  <Text style={styles.demoText}>{pc('device.demoHint')}</Text>
                </View>
              </View>
              <ProductButton label={pc('device.openDemo')} icon="play" variant="secondary" disabled={demo && connected} onPress={openDemo} />
            </ProductCard>
            <SectionHeader title={pc('device.guide')} />
            <ProductCard>
              <View style={styles.demoTop}>
                <View style={styles.securityIcon}><Ionicons name="shield-checkmark-outline" size={27} color={theme.colors.statusConnected} /></View>
                <View style={styles.demoCopy}>
                  <Text style={styles.demoTitle}>{pc('device.guide')}</Text>
                  <Text style={styles.demoText}>{pc('device.addHint')}</Text>
                </View>
              </View>
              <View style={styles.secondaryActions}>
                <ProductButton label={pc('device.guide')} icon="book-outline" variant="secondary" compact onPress={() => setShowGuide(true)} />
                <ProductButton label={pc('tabs.settings')} icon="shield-outline" variant="ghost" compact onPress={() => router.push('/(tabs)/settings')} />
              </View>
            </ProductCard>
            <SavedConnections onSelect={selectSaved} />
          </View>
        </View>
      </ScrollView>
      <SetupGuide visible={showGuide} onClose={() => setShowGuide(false)} onTryDemo={openDemo} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bgBase },
  content: { paddingHorizontal: 18, paddingBottom: 32, width: '100%', maxWidth: theme.sizes.contentMax, alignSelf: 'center' },
  landscapeContent: { maxWidth: 1120, paddingHorizontal: 24 },
  columns: { flexDirection: 'column' },
  columnsLandscape: { flexDirection: 'row', gap: 20 },
  column: { flex: 1, minWidth: 0 },
  helpButton: { width: theme.sizes.touchTarget, height: theme.sizes.touchTarget, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgElevated, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  activeTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  deviceIcon: { width: 48, height: 48, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentPrimaryMuted },
  activeCopy: { flex: 1, minWidth: 0 },
  deviceName: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  deviceAddress: { ...theme.typography.monoXs, color: theme.colors.textMuted, marginTop: 3 },
  connectionDetail: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 16, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: theme.colors.borderSubtle },
  connectionDetailText: { ...theme.typography.bodySm, color: theme.colors.textSecondary },
  sectionHint: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: -4, marginBottom: 10 },
  formCard: { padding: 0, overflow: 'hidden' },
  demoTop: { flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 16 },
  demoIllustration: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.statusConnectingGlow },
  securityIcon: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.statusConnectedGlow },
  demoCopy: { flex: 1, minWidth: 0 },
  demoTitle: { fontSize: 15, color: theme.colors.textPrimary, fontWeight: '600' },
  demoText: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 4 },
  secondaryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
