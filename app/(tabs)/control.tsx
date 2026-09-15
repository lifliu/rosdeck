import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TopicSuggestionModal } from "../../components/TopicSuggestionModal";
import { theme } from "../../constants/theme";
import { suggestLayout, type TopicSuggestion } from "../../lib/topic-detection";
import { LEGACY_VBOT_TELEOP_TOPIC, OMNI_TELEOP_TOPIC, selectPreferredTeleopTarget } from "../../lib/teleop";
import { LOCOMOTION_STATUS_TOPIC } from "../../lib/locomotion-mode";
import {
  acceptTopicSuggestionSession,
  createTopicSuggestionSession,
  refreshTopicSuggestionSession,
  topicSuggestionSourceIsCurrent,
  type TopicSuggestionSession,
} from "../../lib/topic-suggestion-session";
import { useLayoutStore } from "../../stores/useLayoutStore";
import { useOnboardingStore } from "../../stores/useOnboardingStore";
import { useOrientation } from "../../hooks/useOrientation";
import { useRosStore } from "../../stores/useRosStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useControlAuthorityStore } from "../../stores/useControlAuthorityStore";
import { useGamepadInput } from "../../hooks/useGamepadInput";
import { EmergencyStop } from "../../components/EmergencyStop";
import { MappingControl } from "../../components/MappingControl";
import { NavigationControl } from "../../components/NavigationControl";
import { RouteRecordingControl } from "../../components/RouteRecordingControl";
import { PostureControl } from "../../components/PostureControl";
import { ControlAuthorityButton } from "../../components/ControlAuthority";
import { SafetyControl } from "../../components/SafetyControl";
import { useTranslation } from "../../lib/i18n";
import { ControlCockpit } from "../../components/ControlCockpit";

function ConnectionDot() {
  const status = useRosStore((s) => s.connection.status);
  const error = useRosStore((s) => s.connection.error);
  const url = useRosStore((s) => s.connection.url);
  const transportType = useRosStore((s) => s.transportType);
  const disconnect = useRosStore((s) => s.disconnect);
  const [popupVisible, setPopupVisible] = useState(false);
  const { t } = useTranslation();
  const isConnected = status === "connected";

  const dotColor =
    theme.statusColors[status] || theme.colors.statusDisconnected;

  return (
    <>
      <TouchableOpacity
        onPress={() => setPopupVisible(true)}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <View
          style={[
            styles.dot,
            { backgroundColor: dotColor, borderColor: dotColor + "80" },
            Platform.select({
              ios: {
                shadowColor: dotColor,
                shadowRadius: 6,
                shadowOpacity: 0.5,
                shadowOffset: { width: 0, height: 0 },
              },
              android: {
                filter: [
                  {
                    dropShadow: {
                      offsetX: 0,
                      offsetY: 0,
                      standardDeviation: 4,
                      color: dotColor + "88",
                    },
                  },
                ],
              },
            }) as any,
          ]}
        />
      </TouchableOpacity>

      <Modal visible={popupVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.popupOverlay}
          activeOpacity={1}
          onPress={() => setPopupVisible(false)}
        >
          <View style={styles.popupContent}>
            <View style={styles.popupRow}>
              <Text style={styles.popupLabel}>{t('control.status')}</Text>
              <Text style={[styles.popupValue, { color: dotColor }]}>
                {status.toUpperCase()}
              </Text>
            </View>
            {url ? (
              <View style={styles.popupRow}>
                <Text style={styles.popupLabel}>URL</Text>
                <Text style={styles.popupValueMono}>{url}</Text>
              </View>
            ) : null}
            <View style={styles.popupRow}>
              <Text style={styles.popupLabel}>{t('control.transport')}</Text>
              <Text style={styles.popupValue}>
                {transportType.toUpperCase()}
              </Text>
            </View>
            {error ? (
              <View style={styles.popupRow}>
                <Text style={styles.popupLabel}>{t('control.error')}</Text>
                <Text style={styles.popupError}>{error}</Text>
              </View>
            ) : null}
            {isConnected && (
              <>
                <View style={styles.popupDivider} />
                <TouchableOpacity
                  style={styles.disconnectButton}
                  onPress={() => {
                    disconnect();
                    setPopupVisible(false);
                  }}
                >
                  <Ionicons name="power-outline" size={14} color={theme.colors.statusError} />
                  <Text style={styles.disconnectText}>{t('control.disconnect')}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

export default function ControlScreen() {
  const status = useRosStore((s) => s.connection.status);
  const authorityStatus = useControlAuthorityStore((s) => s.status);
  const url = useRosStore((s) => s.connection.url);
  const disconnect = useRosStore((s) => s.disconnect);
  const initForRobot = useLayoutStore((s) => s.initForRobot);
  const router = useRouter();
  const { isLandscape } = useOrientation();
  const isDemo = url?.startsWith("demo://");
  useGamepadInput();
  const { t, language } = useTranslation();
  const [actionsOpen, setActionsOpen] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
      return () => {
        void ScreenOrientation.unlockAsync().catch(() => {});
      };
    }, []),
  );

  const [suggestion, setSuggestion] = useState<TopicSuggestion | null>(null);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [initializedUrl, setInitializedUrl] = useState<string | null>(null);
  const suggestionSessionRef = useRef<TopicSuggestionSession | null>(null);
  const suggestedForUrls = useOnboardingStore((s) => s.suggestedForUrls);
  const addSuggestedUrl = useOnboardingStore((s) => s.addSuggestedUrl);
  const setActiveLayout = useLayoutStore((s) => s.setActiveLayout);
  const updateWidgetConfig = useLayoutStore((s) => s.updateWidgetConfig);

  const handleExitDemo = () => {
    disconnect();
    router.replace("/(tabs)");
  };

  const handleExitControl = useCallback(() => {
    router.replace('/(tabs)' as any);
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    setInitializedUrl(null);
    setSuggestion(null);
    suggestionSessionRef.current = null;
    setShowSuggestion(false);
    if (!url || status !== "connected") return () => { cancelled = true; };

    const initialize = async () => {
      const committed = await initForRobot(url);
      const currentConnection = useRosStore.getState().connection;
      if (cancelled || !committed || currentConnection.status !== "connected" ||
        currentConnection.url !== url) return;
      setInitializedUrl(url);
      if (!url.startsWith("demo://")) {
        useOnboardingStore.getState().setFirstLaunchDone();
      }
    };
    void initialize();
    return () => { cancelled = true; };
  }, [url, status, initForRobot]);

  const autoDetectTopics = useSettingsStore((s) => s.autoDetectTopics);
  useEffect(() => {
    if (status !== "connected" || !url || initializedUrl !== url ||
      url.startsWith("demo://")) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let suggestionHandled = !autoDetectTopics || suggestedForUrls.includes(url);
    const expectedTransport = useRosStore.getState().transport;

    const stillCurrent = () => {
      const rosState = useRosStore.getState();
      return !cancelled && rosState.connection.status === "connected" &&
        rosState.connection.url === url && rosState.transport === expectedTransport &&
        useLayoutStore.getState().robotUrl === url;
    };

    const detectTopics = async () => {
      ++attempts;
      try {
        const topics = await useRosStore.getState().getTopics();
        if (!stillCurrent()) return;
        const teleopTarget = selectPreferredTeleopTarget(topics);
        if (teleopTarget?.topic === OMNI_TELEOP_TOPIC) {
          await useLayoutStore.getState().migrateLegacyTeleopForUnifiedRobot(url);
          if (!stillCurrent()) return;
          const nextSession = refreshTopicSuggestionSession(
            suggestionSessionRef.current,
            { url, transport: expectedTransport },
            suggestLayout(topics),
          );
          if (nextSession !== suggestionSessionRef.current) {
            suggestionSessionRef.current = nextSession;
            setSuggestion(nextSession?.suggestion ?? null);
          }
        } else if (teleopTarget?.topic === LEGACY_VBOT_TELEOP_TOPIC &&
          !teleopTarget.useTwistStamped &&
          useControlAuthorityStore.getState().status === 'unsupported' &&
          topics.some((topic) => topic.name === LOCOMOTION_STATUS_TOPIC &&
            topic.type === 'std_msgs/msg/String')) {
          // A verified legacy VBot connection needs /vel_cmd in every built-in
          // layout, including the layout selected automatically when mapping starts.
          await useLayoutStore.getState().adaptDefaultTeleopForVbot(url);
          if (!stillCurrent()) return;
        }

        if (!suggestionHandled) {
          const result = suggestLayout(topics);
          if (result) {
            suggestionSessionRef.current = createTopicSuggestionSession(
              { url, transport: expectedTransport },
              result,
            );
            setSuggestion(result);
            setShowSuggestion(true);
          }
          addSuggestedUrl(url);
          suggestionHandled = true;
        }
      } catch {}

      // ROS graph discovery is eventually consistent. Retry the capability
      // check for five seconds so an existing ZsiBot layout is not stranded
      // merely because rosapi answered before the arbiter appeared.
      if (stillCurrent() && attempts < 5) {
        retryTimer = setTimeout(detectTopics, 1000);
      }
    };

    retryTimer = setTimeout(detectTopics, 500);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [status, url, initializedUrl, autoDetectTopics, addSuggestedUrl, authorityStatus]);

  const handleAcceptSuggestion = () => {
    const currentRos = useRosStore.getState();
    const acceptedSession = acceptTopicSuggestionSession(
      suggestionSessionRef.current,
      {
        url: currentRos.connection.url,
        transport: currentRos.transport,
        layoutRobotUrl: useLayoutStore.getState().robotUrl,
      },
    );
    if (!acceptedSession) {
      setShowSuggestion(false);
      setSuggestion(null);
      suggestionSessionRef.current = null;
      return;
    }
    const { source, suggestion: acceptedSuggestion } = acceptedSession;
    setActiveLayout(acceptedSuggestion.presetId);

    // Inject detected topic names into widget configs
    setTimeout(() => {
      const latestRos = useRosStore.getState();
      if (!topicSuggestionSourceIsCurrent(source, {
        url: latestRos.connection.url,
        transport: latestRos.transport,
        layoutRobotUrl: useLayoutStore.getState().robotUrl,
      })) return;
      const updated = useLayoutStore.getState().getActiveLayout();
      if (updated) {
        const applyConfigs = (node: any) => {
          if (
            node.type === "widget" &&
            acceptedSuggestion.widgetConfigs[node.widgetType]
          ) {
            updateWidgetConfig(node.id, {
              ...node.config,
              ...acceptedSuggestion.widgetConfigs[node.widgetType],
            });
          }
          if (node.type === "split") {
            node.children.forEach(applyConfigs);
          }
        };
        applyConfigs(updated.tree);
      }
    }, 0);

    setShowSuggestion(false);
    setSuggestion(null);
    suggestionSessionRef.current = null;
  };

  const handleDismissSuggestion = () => {
    setShowSuggestion(false);
    setSuggestion(null);
    suggestionSessionRef.current = null;
  };

  return (
    <SafeAreaView style={styles.container} edges={[]}>
      <StatusBar hidden style="light" />
      <ControlCockpit
        language={language}
        isDemo={Boolean(isDemo)}
        onExit={handleExitControl}
        onExitDemo={handleExitDemo}
        onOpenRobotActions={() => setActionsOpen(true)}
      />

      <Modal visible={actionsOpen} transparent animationType="slide" onRequestClose={() => setActionsOpen(false)}>
        <View style={styles.actionSheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionsOpen(false)} />
          <View style={[styles.actionSheet, isLandscape && styles.actionSheetLandscape]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>{language === 'zh' ? '机器人动作' : 'Robot actions'}</Text>
                <Text style={styles.sheetSubtitle}>{language === 'zh' ? '高风险操作需要二次确认' : 'High-risk actions require confirmation'}</Text>
              </View>
              <TouchableOpacity style={styles.sheetClose} onPress={() => setActionsOpen(false)}>
                <Ionicons name="close" size={21} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetScrollContent}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <View style={styles.actionSection}>
                <Text style={styles.actionSectionLabel}>{language === 'zh' ? '姿态' : 'Posture'}</Text>
                <PostureControl />
              </View>
              <View style={styles.actionSection}>
                <Text style={styles.actionSectionLabel}>{language === 'zh' ? '自主能力' : 'Autonomy'}</Text>
                <View style={styles.actionRow}>
                  <NavigationControl />
                  <MappingControl />
                  <RouteRecordingControl />
                </View>
              </View>
              {!isDemo && (
                <View style={styles.actionSection}>
                  <Text style={styles.actionSectionLabel}>{language === 'zh' ? '安全与控制权' : 'Safety and authority'}</Text>
                  <View style={styles.actionRow}>
                    <ControlAuthorityButton />
                    <SafetyControl />
                  </View>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <TopicSuggestionModal
        visible={showSuggestion}
        suggestion={suggestion}
        onAccept={handleAcceptSuggestion}
        onDismiss={handleDismissSuggestion}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgBase,
  },
  safetyStrip: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle, backgroundColor: theme.colors.bgBase },
  safetyStatus: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  actionsButton: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgElevated },
  actionsButtonText: { fontSize: 12, fontWeight: '600', color: theme.colors.textPrimary },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  disconnected: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  disconnectedTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: theme.colors.textSecondary,
    marginTop: 16,
  },
  disconnectedSubtext: {
    fontSize: 14,
    color: theme.colors.textMuted,
    textAlign: "center",
    marginTop: 8,
  },
  demoBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#FBBF2420",
    borderBottomWidth: 1,
    borderBottomColor: "#FBBF2433",
    paddingVertical: 6,
  },
  demoBannerText: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.statusConnecting,
    letterSpacing: 0,
  },
  actionSheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000099' },
  actionSheet: { backgroundColor: theme.colors.bgElevated, borderTopLeftRadius: theme.radius.xl, borderTopRightRadius: theme.radius.xl, borderWidth: 1, borderBottomWidth: 0, borderColor: theme.colors.borderDefault, paddingHorizontal: 20, paddingBottom: 28, height: '78%' },
  actionSheetLandscape: { width: 430, alignSelf: 'flex-end', height: '100%', maxHeight: '100%', borderTopRightRadius: 0, borderTopLeftRadius: theme.radius.xl },
  sheetScroll: { flex: 1 },
  sheetScrollContent: { paddingBottom: 8 },
  sheetHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, backgroundColor: theme.colors.borderDefault, marginTop: 9, marginBottom: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 10 },
  sheetTitle: { ...theme.typography.headingMd, color: theme.colors.textPrimary },
  sheetSubtitle: { ...theme.typography.bodySm, color: theme.colors.textMuted, marginTop: 2 },
  sheetClose: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSurface },
  actionSection: { paddingVertical: 14, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, gap: 10 },
  actionSectionLabel: { fontSize: 12, color: theme.colors.textMuted, fontWeight: '600' },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Status popup
  popupOverlay: {
    flex: 1,
    backgroundColor: "#00000066",
    justifyContent: "flex-start",
    paddingTop: 100,
    paddingHorizontal: 20,
  },
  popupContent: {
    backgroundColor: theme.colors.bgElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderDefault,
    borderRadius: theme.radius.lg,
    padding: 16,
    gap: 10,
  },
  popupRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  popupLabel: {
    fontFamily: "SpaceMono",
    fontSize: 10,
    color: theme.colors.textMuted,
    letterSpacing: 0.8,
  },
  popupValue: {
    fontFamily: "SpaceMono",
    fontSize: 12,
    color: theme.colors.textPrimary,
    fontWeight: "500",
  },
  popupValueMono: {
    fontFamily: "SpaceMono",
    fontSize: 11,
    color: theme.colors.textValue,
    flexShrink: 1,
    marginLeft: 16,
    textAlign: "right",
  },
  popupError: {
    fontFamily: "SpaceMono",
    fontSize: 10,
    color: theme.colors.statusError,
    flexShrink: 1,
    marginLeft: 16,
    textAlign: "right",
  },
  popupDivider: {
    height: 1,
    backgroundColor: theme.colors.borderSubtle,
    marginTop: 2,
  },
  disconnectButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.statusError + "44",
    backgroundColor: theme.colors.statusError + "11",
  },
  disconnectText: {
    fontFamily: "SpaceMono",
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.statusError,
  },
});
