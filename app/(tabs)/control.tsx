import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LayoutManager } from "../../components/LayoutManager";
import { LayoutRenderer } from "../../components/LayoutRenderer";
import { TopicSuggestionModal } from "../../components/TopicSuggestionModal";
import { theme } from "../../constants/theme";
import { suggestLayout, type TopicSuggestion } from "../../lib/topic-detection";
import { OMNI_TELEOP_TOPIC, selectPreferredTeleopTarget } from "../../lib/teleop";
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
import { useGamepadInput } from "../../hooks/useGamepadInput";
import { MappingControl } from "../../components/MappingControl";
import { PostureControl } from "../../components/PostureControl";
import { ControlAuthorityButton } from "../../components/ControlAuthority";
import { SafetyControl } from "../../components/SafetyControl";
import { useTranslation } from "../../lib/i18n";

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
  const url = useRosStore((s) => s.connection.url);
  const disconnect = useRosStore((s) => s.disconnect);
  const initForRobot = useLayoutStore((s) => s.initForRobot);
  const router = useRouter();
  const { isLandscape } = useOrientation();
  const isDemo = url?.startsWith("demo://");
  useGamepadInput();
  const { t } = useTranslation();

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
    router.push("/(tabs)");
  };

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
  }, [status, url, initializedUrl, autoDetectTopics, addSuggestedUrl]);

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
    <SafeAreaView style={styles.container} edges={isLandscape ? [] : ["top"]}>
      {isLandscape ? (
        // In landscape, LayoutManager is invisible but still renders its modals.
        // The rail button triggers it via layoutListOpen store flag.
        <View style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
          <LayoutManager />
        </View>
      ) : (
        <View style={styles.topBar}>
          <ConnectionDot />
          <LayoutManager />
        </View>
      )}

      {!isLandscape && (
        <View style={styles.robotActions}>
          <ControlAuthorityButton />
          <SafetyControl />
          <PostureControl />
          <MappingControl />
        </View>
      )}

      {isLandscape && (
        <View style={styles.landscapeActions}>
          <ControlAuthorityButton compact />
          <SafetyControl compact />
          <PostureControl compact />
          <MappingControl compact />
        </View>
      )}

      {isDemo && status === "connected" && (
        <TouchableOpacity style={styles.demoBanner} onPress={handleExitDemo}>
          <Text style={styles.demoBannerText}>{t('control.demoMode')}</Text>
          <Ionicons
            name="close-circle-outline"
            size={14}
            color={theme.colors.statusConnecting}
          />
        </TouchableOpacity>
      )}

      {status !== "connected" ? (
        <View style={styles.disconnected}>
          <Ionicons
            name="wifi-outline"
            size={48}
            color={theme.colors.textMuted}
          />
          <Text style={styles.disconnectedTitle}>{t('control.notConnected')}</Text>
          <Text style={styles.disconnectedSubtext}>
            {t('control.notConnectedHint')}
          </Text>
        </View>
      ) : (
        <LayoutRenderer />
      )}

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
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefault,
  },
  robotActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefault,
  },
  landscapeActions: {
    position: 'absolute',
    top: 8,
    right: 10,
    zIndex: 20,
    flexDirection: 'row',
    gap: 8,
  },
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
    paddingVertical: 4,
  },
  demoBannerText: {
    fontFamily: "SpaceMono",
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.statusConnecting,
    letterSpacing: 0.8,
  },
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
