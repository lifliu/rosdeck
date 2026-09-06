import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../constants/theme';
import { useTranslation } from '../lib/i18n';
import {
  formatMapSize,
  listMaps,
  mapIdentityKey,
  type MapCatalogEntry,
  type MapIdentity,
} from '../lib/maps';
import { useRosStore } from '../stores/useRosStore';

interface MapCatalogPickerProps {
  visible: boolean;
  title: string;
  confirmLabel: string;
  currentIdentity?: MapIdentity | null;
  onCancel: () => void;
  onSelect: (entry: MapCatalogEntry) => void;
}

/**
 * 展示 Mission Manager 每次实时返回的地图目录。组件不使用持久化存储，也不
 * 在连接间保留目录或选择，避免手机缓存被误当成机器人资产真值。
 */
export function MapCatalogPicker({
  visible,
  title,
  confirmLabel,
  currentIdentity,
  onCancel,
  onSelect,
}: MapCatalogPickerProps) {
  const transport = useRosStore((state) => state.transport);
  const connectionStatus = useRosStore((state) => state.connection.status);
  const [entries, setEntries] = useState<MapCatalogEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestSerial = useRef(0);
  const { t } = useTranslation();
  const currentKey = currentIdentity ? mapIdentityKey(currentIdentity) : '';

  const cancel = useCallback(() => {
    // 在父组件完成重渲染前就作废网络响应，避免关闭瞬间回写已不可见目录。
    requestSerial.current += 1;
    onCancel();
  }, [onCancel]);

  const refresh = useCallback(async () => {
    const serial = ++requestSerial.current;
    setLoading(true);
    setError('');
    if (!transport || connectionStatus !== 'connected') {
      setEntries([]);
      setSelectedKey('');
      setError(t('mapCatalog.disconnected'));
      setLoading(false);
      return;
    }
    try {
      const catalog = await listMaps(transport);
      if (serial !== requestSerial.current) return;
      setEntries(catalog);
      // 只能在这次响应中恢复选择；上一轮目录中存在的条目不再被信任。
      setSelectedKey((previous) => {
        if (catalog.some((entry) => mapIdentityKey(entry) === previous)) return previous;
        if (currentKey && catalog.some((entry) => mapIdentityKey(entry) === currentKey)) {
          return currentKey;
        }
        return catalog.length === 1 ? mapIdentityKey(catalog[0]) : '';
      });
    } catch (caught: any) {
      if (serial !== requestSerial.current) return;
      setEntries([]);
      setSelectedKey('');
      setError(caught?.message || String(caught));
    } finally {
      if (serial === requestSerial.current) setLoading(false);
    }
  }, [connectionStatus, currentKey, t, transport]);

  useEffect(() => {
    if (visible) {
      void refresh();
      return () => {
        requestSerial.current += 1;
      };
    }
    // 关闭即作废请求并清除目录，确保下次打开一定重新查询机器人。
    requestSerial.current += 1;
    setEntries([]);
    setSelectedKey('');
    setError('');
    setLoading(false);
  }, [refresh, visible]);

  const selected = useMemo(
    () => entries.find((entry) => mapIdentityKey(entry) === selectedKey) ?? null,
    [entries, selectedKey],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={cancel} />
        <View style={styles.dialog}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.hint}>{t('mapCatalog.hint')}</Text>
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('mapCatalog.refresh')}
              disabled={loading}
              onPress={() => void refresh()}
              style={[styles.iconButton, loading && styles.disabled]}
            >
              <Ionicons name="refresh-outline" size={20} color={theme.colors.accentPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.catalogArea}>
            {loading ? (
              <View style={styles.centerState}>
                <ActivityIndicator color={theme.colors.accentPrimary} />
                <Text style={styles.stateText}>{t('mapCatalog.loading')}</Text>
              </View>
            ) : error ? (
              <View style={styles.centerState}>
                <Ionicons name="warning-outline" size={24} color={theme.colors.statusError} />
                <Text style={styles.errorText}>{t('mapCatalog.failed', { message: error })}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={() => void refresh()}>
                  <Text style={styles.retryText}>{t('mapCatalog.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : entries.length === 0 ? (
              <View style={styles.centerState}>
                <Ionicons name="map-outline" size={24} color={theme.colors.textMuted} />
                <Text style={styles.stateText}>{t('mapCatalog.empty')}</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={styles.list}>
                {entries.map((entry) => {
                  const key = mapIdentityKey(entry);
                  const selectedRow = key === selectedKey;
                  const current = key === currentKey;
                  return (
                    <TouchableOpacity
                      key={key}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selectedRow }}
                      accessibilityLabel={`${entry.mapId}, v${entry.mapVersion}`}
                      onPress={() => setSelectedKey(key)}
                      activeOpacity={0.72}
                      style={[styles.row, selectedRow && styles.selectedRow]}
                    >
                      <Ionicons
                        name={selectedRow ? 'radio-button-on' : 'radio-button-off'}
                        size={20}
                        color={selectedRow ? theme.colors.accentPrimary : theme.colors.textMuted}
                      />
                      <View style={styles.rowBody}>
                        <View style={styles.rowTitleLine}>
                          <Text style={styles.mapId} numberOfLines={1}>{entry.mapId}</Text>
                          <Text style={styles.version}>v{entry.mapVersion}</Text>
                          {current ? (
                            <Text style={styles.currentBadge}>{t('mapCatalog.current')}</Text>
                          ) : null}
                        </View>
                        <Text style={styles.metadata} numberOfLines={1}>
                          {t('mapCatalog.created', {
                            created: entry.createdAt.replace('T', ' '),
                            size: formatMapSize(entry.sizeBytes),
                          })}
                        </Text>
                        <Text style={styles.checksum} numberOfLines={1}>
                          SHA-256 · {entry.mapChecksum}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.secondaryButton} onPress={cancel}>
              <Text style={styles.secondaryText}>{t('mapCatalog.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!selected || loading}
              style={[styles.primaryButton, (!selected || loading) && styles.disabled]}
              onPress={() => selected && onSelect(selected)}
            >
              <Text style={styles.primaryText}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 10, backgroundColor: '#00000099' },
  dialog: { width: 560, maxWidth: '96%', maxHeight: '94%', flexShrink: 1, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgElevated },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  heading: { flex: 1 },
  title: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: '700' },
  hint: { color: theme.colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },
  iconButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSurface },
  catalogArea: { minHeight: 80, maxHeight: 310, flexShrink: 1, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgInset, overflow: 'hidden' },
  centerState: { minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10 },
  stateText: { color: theme.colors.textMuted, fontSize: 12, textAlign: 'center' },
  errorText: { color: theme.colors.statusError, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  retryButton: { minHeight: 36, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: theme.colors.accentPrimary + '77' },
  retryText: { color: theme.colors.accentPrimary, fontSize: 12, fontWeight: '700' },
  list: { padding: 8, gap: 7 },
  row: { minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSurface },
  selectedRow: { borderColor: theme.colors.accentPrimary, backgroundColor: theme.colors.accentPrimary + '12' },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  mapId: { maxWidth: '58%', color: theme.colors.textPrimary, fontSize: 14, fontWeight: '700' },
  version: { color: theme.colors.accentPrimary, fontFamily: 'SpaceMono', fontSize: 11 },
  currentBadge: { color: theme.colors.statusConnected, borderWidth: 1, borderColor: theme.colors.statusConnected + '66', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, fontSize: 9 },
  metadata: { marginTop: 4, color: theme.colors.textSecondary, fontSize: 10 },
  checksum: { marginTop: 3, color: theme.colors.textMuted, fontFamily: 'SpaceMono', fontSize: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
  secondaryButton: { minHeight: 42, minWidth: 92, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: theme.colors.borderDefault },
  secondaryText: { color: theme.colors.textSecondary, fontWeight: '700' },
  primaryButton: { minHeight: 42, minWidth: 132, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: theme.colors.accentPrimary },
  primaryText: { color: '#061014', fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
