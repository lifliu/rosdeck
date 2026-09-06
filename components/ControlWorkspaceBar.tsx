import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../constants/theme';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useLayoutStore } from '../stores/useLayoutStore';
import { LayoutManager } from './LayoutManager';

const WORKSPACES = [
  { id: 'drive-camera', zh: '驾驶', en: 'Drive', icon: 'game-controller-outline' },
  { id: 'nav', zh: '地图', en: 'Map', icon: 'map-outline' },
  { id: 'camera-only', zh: '视频', en: 'Video', icon: 'videocam-outline' },
  { id: 'mapping-3d', zh: '建图', en: 'Mapping', icon: 'cube-outline' },
  { id: 'dashboard', zh: '总览', en: 'Overview', icon: 'grid-outline' },
] as const;

export function ControlWorkspaceBar() {
  const language = useSettingsStore((s) => s.language);
  const layouts = useLayoutStore((s) => s.layouts);
  const activeLayoutId = useLayoutStore((s) => s.activeLayoutId);
  const editMode = useLayoutStore((s) => s.editMode);
  const setActiveLayout = useLayoutStore((s) => s.setActiveLayout);
  const setEditMode = useLayoutStore((s) => s.setEditMode);

  return (
    <View style={styles.container}>
      <View style={styles.hiddenManager}><LayoutManager /></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {WORKSPACES.filter((workspace) => layouts.some((layout) => layout.id === workspace.id)).map((workspace) => {
          const active = workspace.id === activeLayoutId;
          return (
            <TouchableOpacity
              key={workspace.id}
              style={[styles.workspace, active && styles.workspaceActive]}
              onPress={() => setActiveLayout(workspace.id)}
              activeOpacity={0.72}
            >
              <Ionicons name={workspace.icon} size={16} color={active ? theme.colors.bgBase : theme.colors.textSecondary} />
              <Text style={[styles.workspaceText, active && styles.workspaceTextActive]}>{language === 'zh' ? workspace.zh : workspace.en}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <TouchableOpacity
        accessibilityLabel={language === 'zh' ? '管理工作区' : 'Manage workspaces'}
        style={styles.iconButton}
        onPress={() => useLayoutStore.setState({ layoutListOpen: true })}
      >
        <Ionicons name="layers-outline" size={19} color={theme.colors.textSecondary} />
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel={language === 'zh' ? '编辑布局' : 'Edit layout'}
        style={[styles.iconButton, editMode && styles.iconButtonActive]}
        onPress={() => setEditMode(!editMode)}
      >
        <Ionicons name={editMode ? 'checkmark' : 'pencil-outline'} size={19} color={editMode ? theme.colors.bgBase : theme.colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle, backgroundColor: theme.colors.bgElevated },
  hiddenManager: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  scrollContent: { gap: 7, paddingVertical: 9 },
  workspace: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, borderRadius: theme.radius.pill, backgroundColor: theme.colors.bgInset, borderWidth: 1, borderColor: theme.colors.borderSubtle },
  workspaceActive: { backgroundColor: theme.colors.accentPrimary, borderColor: theme.colors.accentPrimary },
  workspaceText: { fontSize: 12, color: theme.colors.textSecondary, fontWeight: '600' },
  workspaceTextActive: { color: theme.colors.bgBase },
  iconButton: { width: 42, height: 42, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: theme.colors.bgInset },
  iconButtonActive: { backgroundColor: theme.colors.accentPrimary, borderColor: theme.colors.accentPrimary },
});
