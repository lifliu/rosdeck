import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, StyleSheet } from 'react-native';
import { theme } from '../constants/theme';
import type { TopicSuggestion } from '../lib/topic-detection';
import { PRESET_TEMPLATES } from '../constants/presets';
import { Ionicons } from '@expo/vector-icons';
import { useSettingsStore } from '../stores/useSettingsStore';

interface Props {
  visible: boolean;
  suggestion: TopicSuggestion | null;
  onAccept: () => void;
  onDismiss: () => void;
}

function shortType(fullType: string): string {
  const parts = fullType.split('/');
  return parts[parts.length - 1];
}

export function TopicSuggestionModal({ visible, suggestion, onAccept, onDismiss }: Props) {
  const language = useSettingsStore((s) => s.language);
  if (!suggestion) return null;

  const presetName = PRESET_TEMPLATES.find((p) => p.id === suggestion.presetId)?.name ?? suggestion.presetId;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.modalHeading}><View style={styles.headingIcon}><Ionicons name="sparkles-outline" size={22} color={theme.colors.accentPrimary} /></View><View><Text style={styles.title}>{language === 'zh' ? '发现机器人能力' : 'Robot capabilities found'}</Text><Text style={styles.headingHint}>{language === 'zh' ? '根据实时 Topics 推荐工作区' : 'Workspace suggested from live topics'}</Text></View></View>

          <ScrollView style={styles.topicList}>
            {suggestion.detectedTopics.map((topic) => (
              <View key={topic.name} style={styles.topicRow}>
                <Text style={styles.topicName} numberOfLines={1}>{topic.name}</Text>
                <Text style={styles.topicType}>{shortType(topic.type)}</Text>
              </View>
            ))}
          </ScrollView>

          <View style={styles.suggestion}>
            <Text style={styles.suggestLabel}>{language === 'zh' ? '推荐工作区' : 'SUGGESTED WORKSPACE'}</Text>
            <Text style={styles.suggestName}>{presetName}</Text>
          </View>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.button, styles.dismissButton]} onPress={onDismiss}>
              <Text style={styles.dismissText}>{language === 'zh' ? '暂不使用' : 'Not now'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.acceptButton]} onPress={onAccept}>
              <Text style={styles.acceptText}>{language === 'zh' ? '应用推荐' : 'Apply'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#000000CC',
    justifyContent: 'center',
    padding: 24,
  },
  container: {
    backgroundColor: theme.colors.bgElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    borderRadius: theme.radius.lg,
    padding: 20,
  },
  modalHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  headingIcon: { width: 46, height: 46, borderRadius: 14, backgroundColor: theme.colors.accentPrimaryMuted, alignItems: 'center', justifyContent: 'center' },
  headingHint: { fontSize: 12, color: theme.colors.textMuted, marginTop: 2 },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  topicList: {
    maxHeight: 200,
  },
  topicRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderSubtle,
  },
  topicName: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    color: theme.colors.textValue,
    flex: 1,
    marginRight: 12,
  },
  topicType: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: theme.colors.textMuted,
  },
  suggestion: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderDefault,
    alignItems: 'center',
  },
  suggestLabel: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    color: theme.colors.textMuted,
    letterSpacing: 0.8,
  },
  suggestName: {
    fontFamily: 'SpaceMono',
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginTop: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  button: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    alignItems: 'center',
  },
  dismissButton: {
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
  },
  dismissText: {
    fontSize: 14,
    fontWeight: '500',
    color: theme.colors.textSecondary,
  },
  acceptButton: {
    backgroundColor: theme.colors.accentPrimary,
  },
  acceptText: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.bgBase,
  },
});
