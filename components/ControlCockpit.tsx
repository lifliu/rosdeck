import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULTS } from '../constants/defaults';
import { theme } from '../constants/theme';
import {
  MISSION_EVENTS_TOPIC,
  MISSION_EVENTS_TYPE,
  MISSION_STATUS_TOPIC,
  MISSION_STATUS_TYPE,
  ROBOT_STATE_TOPIC,
  ROBOT_STATE_TYPE,
  cancelMission,
  dispatchMission,
  generateRequestId,
  listRoutes,
  pauseMission,
  resumeMission,
} from '../lib/mission/api';
import {
  INSPECTION_RUNTIME_STATUS_TOPIC,
  INSPECTION_RUNTIME_STATUS_TYPE,
  commandInspectionRuntime,
  extractInspectionRuntimeStatus,
  parseInspectionRuntimeState,
  type InspectionRuntimeState,
} from '../lib/mission/runtime';
import { ACTIVE_MISSION_STATES, MISSION_STATE, type ControlResponse } from '../lib/mission/types';
import {
  dispatchTouchEnd,
  dispatchTouchMove,
  dispatchTouchStart,
  setDeltaTransform,
} from '../lib/touch-dispatcher';
import { useLayoutStore } from '../stores/useLayoutStore';
import { useMissionStore } from '../stores/useMissionStore';
import { useRosStore } from '../stores/useRosStore';
import type { LayoutNode, SavedLayout, WidgetConfigField, WidgetNode } from '../types/layout';
import { cameraWidget } from '../widgets/camera';
import { mapWidget } from '../widgets/map';
import { CameraFeed } from './CameraFeed';
import { EmergencyStop } from './EmergencyStop';
import { Joystick } from './Joystick';
import { LayoutManager } from './LayoutManager';
import { WidgetSettings } from './WidgetSettings';
import { MapWidget } from '../widgets/map/MapWidget';

type Scene = 'video' | 'map';

interface ControlCockpitProps {
  language: 'zh' | 'en';
  isDemo: boolean;
  onExit: () => void;
  onExitDemo: () => void;
  onOpenRobotActions: () => void;
}

function findWidget(node: LayoutNode | undefined, widgetType: string): WidgetNode | null {
  if (!node) return null;
  if (node.type === 'widget') return node.widgetType === widgetType ? node : null;
  return findWidget(node.children[0], widgetType) || findWidget(node.children[1], widgetType);
}

export interface LocatedWidget {
  layoutId: string;
  node: WidgetNode;
}

/**
 * 控制台会全屏复用布局中的部件配置。优先读取当前布局；当前布局没有该部件时，
 * 再选择第一个可用配置，并保留所属 layoutId，确保编辑结果能写回正确布局。
 */
export function preferredWidget(
  layouts: SavedLayout[],
  activeLayoutId: string,
  widgetType: string,
): LocatedWidget | null {
  const active = layouts.find((layout) => layout.id === activeLayoutId);
  const fromActive = findWidget(active?.tree, widgetType);
  if (active && fromActive) return { layoutId: active.id, node: fromActive };
  for (const layout of layouts) {
    const node = findWidget(layout.tree, widgetType);
    if (node) return { layoutId: layout.id, node };
  }
  return null;
}

function CockpitButton({
  icon,
  label,
  active = false,
  danger = false,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.cockpitButton, active && styles.cockpitButtonActive, danger && styles.cockpitButtonDanger]}
      activeOpacity={0.72}
      onPress={onPress}
    >
      <Ionicons
        name={icon}
        size={21}
        color={danger ? theme.colors.statusError : active ? '#FFFFFF' : theme.colors.textPrimary}
      />
      <Text style={[styles.cockpitButtonText, danger && styles.cockpitButtonDangerText]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const missionStateLabel = (state: number, zh: boolean) => {
  switch (state) {
    case MISSION_STATE.PENDING: return zh ? '等待执行' : 'Pending';
    case MISSION_STATE.EXECUTING: return zh ? '巡检中' : 'Inspecting';
    case MISSION_STATE.PAUSED: return zh ? '已暂停' : 'Paused';
    case MISSION_STATE.SUCCEEDED: return zh ? '已完成' : 'Completed';
    case MISSION_STATE.CANCELED: return zh ? '已取消' : 'Canceled';
    case MISSION_STATE.FAILED: return zh ? '执行失败' : 'Failed';
    case MISSION_STATE.INTERRUPTED: return zh ? '已中断' : 'Interrupted';
    default: return zh ? '无任务' : 'No mission';
  }
};

export function ControlCockpit({
  language,
  isDemo,
  onExit,
  onExitDemo,
  onOpenRobotActions,
}: ControlCockpitProps) {
  const zh = language === 'zh';
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const status = useRosStore((state) => state.connection.status);
  const transport = useRosStore((state) => state.transport);
  const url = useRosStore((state) => state.connection.url);
  const layouts = useLayoutStore((state) => state.layouts);
  const activeLayoutId = useLayoutStore((state) => state.activeLayoutId);
  const editMode = useLayoutStore((state) => state.editMode);
  const setEditMode = useLayoutStore((state) => state.setEditMode);
  const updateWidgetConfigInLayout = useLayoutStore((state) => state.updateWidgetConfigInLayout);
  const [scene, setScene] = useState<Scene>('video');
  const [missionsOpen, setMissionsOpen] = useState(false);
  const [inspectionRuntimeState, setInspectionRuntimeState] =
    useState<InspectionRuntimeState>('unknown');
  const [inspectionRuntimeStatus, setInspectionRuntimeStatus] = useState('');
  const inspectionCommandSentRef = useRef(false);
  const inspectionStatusStaleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const routes = useMissionStore((state) => state.routes);
  const routesLoaded = useMissionStore((state) => state.routesLoaded);
  const selectedRouteId = useMissionStore((state) => state.selectedRouteId);
  const mission = useMissionStore((state) => state.status);
  const dispatching = useMissionStore((state) => state.dispatching);
  const controlling = useMissionStore((state) => state.controlling);
  const lastError = useMissionStore((state) => state.lastError);

  const connected = status === 'connected' && Boolean(transport);
  const missionConnected = connected && !isDemo;
  const missionState = mission?.state ?? MISSION_STATE.NONE;
  const missionActive = ACTIVE_MISSION_STATES.includes(missionState);
  const inspectionRuntimeReady =
    inspectionRuntimeState === 'running_managed' ||
    inspectionRuntimeState === 'running_external';

  const cameraSelection = useMemo(
    () => preferredWidget(layouts, activeLayoutId, 'camera'),
    [activeLayoutId, layouts],
  );
  const cameraConfig = cameraSelection?.node.config ?? cameraWidget.defaultConfig;
  const cameraSettingsSchema = useMemo<WidgetConfigField[]>(() => [
    {
      key: 'source',
      label: zh ? '传输方式' : 'Transport',
      type: 'select',
      options: [
        { label: zh ? 'Foxglove 直连' : 'Foxglove direct', value: 'transport' },
        { label: zh ? 'MJPEG 服务' : 'MJPEG server', value: 'mjpeg' },
      ],
    },
    {
      key: 'topic',
      label: zh ? '视频话题' : 'Video topic',
      type: 'topic',
      topicMessageTypes: ['sensor_msgs/msg/CompressedImage', 'foxglove_msgs/msg/CompressedVideo'],
    },
    {
      key: 'mjpegPort',
      label: zh ? 'MJPEG 端口' : 'MJPEG port',
      type: 'number',
      visibleWhen: { key: 'source', value: 'mjpeg' },
    },
    {
      key: 'maxFps',
      label: zh ? '最大显示帧率' : 'Maximum display rate',
      type: 'slider',
      min: 1,
      max: 30,
      step: 1,
      unit: 'fps',
      visibleWhen: { key: 'source', value: 'transport' },
    },
  ], [zh]);
  const mapConfig = useMemo(
    () => ({ ...mapWidget.defaultConfig, ...(preferredWidget(layouts, activeLayoutId, 'map')?.node.config ?? {}), enableNav2Goal: false }),
    [activeLayoutId, layouts],
  );
  const joystickConfig = useMemo(
    () => ({
      topic: DEFAULTS.cmdVelTopic,
      useTwistStamped: DEFAULTS.cmdVelUseTwistStamped,
      frameId: 'base_link',
      maxLinearVel: DEFAULTS.maxLinearVel,
      maxAngularVel: DEFAULTS.maxAngularVel,
      requireLocoMode: true,
      ...(preferredWidget(layouts, activeLayoutId, 'joystick')?.node.config ?? {}),
      overlayMode: true,
    }),
    [activeLayoutId, layouts],
  );

  useEffect(() => {
    setDeltaTransform((dx, dy) => ({ dx, dy }));
    return () => {
      setDeltaTransform((dx, dy) => ({ dx, dy }));
      // 离开控制页时不能把编辑态遗留给下一次会话。
      useLayoutStore.getState().setEditMode(false);
    };
  }, []);

  useEffect(() => {
    if (!missionConnected || !transport) {
      useMissionStore.getState().resetFeed();
      setInspectionRuntimeState('unknown');
      setInspectionRuntimeStatus('');
      inspectionCommandSentRef.current = false;
      if (inspectionStatusStaleTimerRef.current) {
        clearTimeout(inspectionStatusStaleTimerRef.current);
        inspectionStatusStaleTimerRef.current = null;
      }
      return;
    }
    const subscriptions = [
      transport.subscribe(MISSION_STATUS_TOPIC, MISSION_STATUS_TYPE, (message) => useMissionStore.getState().onStatus(message)),
      transport.subscribe(MISSION_EVENTS_TOPIC, MISSION_EVENTS_TYPE, (message) => useMissionStore.getState().onEvent(message)),
      transport.subscribe(ROBOT_STATE_TOPIC, ROBOT_STATE_TYPE, (message) => useMissionStore.getState().onRobotState(message)),
      transport.subscribe(
        INSPECTION_RUNTIME_STATUS_TOPIC,
        INSPECTION_RUNTIME_STATUS_TYPE,
        (message) => {
          const runtimeStatus = extractInspectionRuntimeStatus(message);
          if (!runtimeStatus) return;
          setInspectionRuntimeStatus(runtimeStatus);
          setInspectionRuntimeState(parseInspectionRuntimeState(runtimeStatus));

          // Bridge 每秒发布一次权威心跳。状态源消失时回到 unknown，禁止继续
          // 调 Mission Service，避免使用 transient-local 的陈旧最后一帧。
          if (inspectionStatusStaleTimerRef.current) {
            clearTimeout(inspectionStatusStaleTimerRef.current);
          }
          inspectionStatusStaleTimerRef.current = setTimeout(() => {
            setInspectionRuntimeState('unknown');
            setInspectionRuntimeStatus('');
          }, 3500);
        },
      ),
    ];
    return () => {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      if (inspectionStatusStaleTimerRef.current) {
        clearTimeout(inspectionStatusStaleTimerRef.current);
        inspectionStatusStaleTimerRef.current = null;
      }
    };
  }, [missionConnected, transport]);

  const refreshRoutes = useCallback(() => {
    if (!transport || !missionConnected || !inspectionRuntimeReady) return;
    useMissionStore.getState().setError(null);
    listRoutes(transport)
      .then((items) => useMissionStore.getState().setRoutes(items))
      .catch((error: any) => useMissionStore.getState().setError(error?.message || String(error)));
  }, [inspectionRuntimeReady, missionConnected, transport]);

  useEffect(() => {
    if (!missionsOpen) {
      inspectionCommandSentRef.current = false;
      return;
    }
    if (!transport || !missionConnected) return;

    if ((inspectionRuntimeState === 'idle' ||
      inspectionRuntimeState === 'switchable_navigation') &&
      !inspectionCommandSentRef.current)
    {
      inspectionCommandSentRef.current = true;
      useMissionStore.getState().setError(null);
      commandInspectionRuntime(transport, true);
      return;
    }
    if (inspectionRuntimeReady) {
      refreshRoutes();
    }
  }, [
    inspectionRuntimeReady,
    inspectionRuntimeState,
    missionConnected,
    missionsOpen,
    refreshRoutes,
    transport,
  ]);

  const openInspectionPanel = useCallback(() => {
    useMissionStore.getState().setError(null);
    setMissionsOpen(true);
  }, []);

  const retryInspectionRuntime = useCallback(() => {
    if (!transport || !missionConnected ||
      (inspectionRuntimeState !== 'idle' &&
      inspectionRuntimeState !== 'switchable_navigation')) return;
    inspectionCommandSentRef.current = true;
    useMissionStore.getState().setError(null);
    commandInspectionRuntime(transport, true);
  }, [inspectionRuntimeState, missionConnected, transport]);

  const dispatchSelectedRoute = useCallback(() => {
    if (!transport || !selectedRouteId || !inspectionRuntimeReady) return;
    Alert.alert(
      zh ? '开始巡检任务？' : 'Start inspection mission?',
      zh ? `将派发路线「${selectedRouteId}」，机器人会进入自主巡检。` : `Dispatch route “${selectedRouteId}” for autonomous inspection.`,
      [
        { text: zh ? '取消' : 'Cancel', style: 'cancel' },
        {
          text: zh ? '确认开始' : 'Start',
          onPress: async () => {
            const store = useMissionStore.getState();
            const pending = store.pendingDispatch;
            const requestId = pending?.routeId === selectedRouteId ? pending.requestId : generateRequestId();
            store.setPendingDispatch({ requestId, routeId: selectedRouteId });
            store.setDispatching(true);
            store.setError(null);
            try {
              const response = await dispatchMission(transport, { routeId: selectedRouteId, requestId });
              if (response.accepted) {
                store.setPendingDispatch(null);
                setMissionsOpen(false);
              } else {
                store.setError(response.reason_text || (zh ? '任务管理器拒绝了请求' : 'Mission Manager rejected the request'));
              }
            } catch (error: any) {
              store.setError(error?.message || String(error));
            } finally {
              useMissionStore.getState().setDispatching(false);
            }
          },
        },
      ],
    );
  }, [inspectionRuntimeReady, selectedRouteId, transport, zh]);

  const runMissionControl = useCallback(async (call: (missionId?: string) => Promise<ControlResponse>) => {
    const store = useMissionStore.getState();
    store.setControlling(true);
    store.setError(null);
    try {
      const response = await call(mission?.mission_id || undefined);
      if (!response.accepted) store.setError(response.reason_text || (zh ? '任务控制请求被拒绝' : 'Mission control request rejected'));
    } catch (error: any) {
      store.setError(error?.message || String(error));
    } finally {
      useMissionStore.getState().setControlling(false);
    }
  }, [mission?.mission_id, zh]);

  const confirmCancelMission = useCallback(() => {
    if (!transport) return;
    Alert.alert(
      zh ? '停止巡检任务？' : 'Stop inspection mission?',
      zh ? '机器人将取消当前任务并停止自主巡检。' : 'The robot will cancel the active autonomous inspection.',
      [
        { text: zh ? '返回' : 'Back', style: 'cancel' },
        { text: zh ? '停止任务' : 'Stop mission', style: 'destructive', onPress: () => void runMissionControl((mid) => cancelMission(transport, mid)) },
      ],
    );
  }, [runMissionControl, transport, zh]);

  return (
    <View
      style={styles.root}
      onTouchStart={(event) => dispatchTouchStart([...event.nativeEvent.changedTouches])}
      onTouchMove={(event) => dispatchTouchMove([...event.nativeEvent.changedTouches])}
      onTouchEnd={(event) => dispatchTouchEnd([...event.nativeEvent.changedTouches])}
      onTouchCancel={(event) => dispatchTouchEnd([...event.nativeEvent.changedTouches])}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {connected ? (
          scene === 'video' ? (
            <CameraFeed config={cameraConfig} width={width} height={height} />
          ) : (
            <MapWidget config={mapConfig} width={width} height={height} />
          )
        ) : (
          <View style={styles.offlineBackground}>
            <Ionicons name="videocam-off-outline" size={58} color={theme.colors.textMuted} />
            <Text style={styles.offlineTitle}>{zh ? '机器人未连接' : 'Robot disconnected'}</Text>
            <Text style={styles.offlineMessage}>{zh ? '退出控制页并前往设备页建立连接' : 'Exit control and connect from the Devices tab'}</Text>
          </View>
        )}
        <View style={styles.sceneShadeTop} />
        <View style={styles.sceneShadeBottom} />
        {scene === 'video' && connected ? <View style={styles.reticle}><View style={styles.reticleH} /><View style={styles.reticleV} /></View> : null}
      </View>

      {connected ? (
        <Joystick config={joystickConfig} width={width} height={height} />
      ) : null}

      <View pointerEvents="box-none" style={[styles.topBar, { paddingTop: Math.max(8, insets.top), paddingLeft: Math.max(10, insets.left + 8), paddingRight: Math.max(10, insets.right + 8) }]}>
        <View style={styles.topGroup}>
          <CockpitButton icon="arrow-back" label={zh ? '退出控制' : 'Exit'} onPress={onExit} />
          <View style={styles.connectionPill}>
            <View style={[styles.connectionDot, { backgroundColor: connected ? theme.colors.statusConnected : theme.colors.statusError }]} />
            <View>
              <Text style={styles.connectionLabel}>{connected ? (zh ? '已连接' : 'Connected') : (zh ? '未连接' : 'Offline')}</Text>
              <Text style={styles.connectionUrl} numberOfLines={1}>{isDemo ? (zh ? '演示模式' : 'Demo mode') : (url || '—')}</Text>
            </View>
          </View>
        </View>

        <View style={styles.sceneSwitch}>
          <TouchableOpacity style={[styles.sceneSwitchItem, scene === 'video' && styles.sceneSwitchItemActive]} onPress={() => setScene('video')}>
            <Ionicons name="videocam-outline" size={17} color={scene === 'video' ? '#FFFFFF' : theme.colors.textSecondary} />
            <Text style={[styles.sceneSwitchText, scene === 'video' && styles.sceneSwitchTextActive]}>{zh ? '视频' : 'Video'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.sceneSwitchItem, scene === 'map' && styles.sceneSwitchItemActive]} onPress={() => setScene('map')}>
            <Ionicons name="map-outline" size={17} color={scene === 'map' ? '#FFFFFF' : theme.colors.textSecondary} />
            <Text style={[styles.sceneSwitchText, scene === 'map' && styles.sceneSwitchTextActive]}>{zh ? '地图' : 'Map'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.topGroup}>
          <EmergencyStop />
        </View>
      </View>

      <View pointerEvents="box-none" style={[styles.rightDock, { right: Math.max(12, insets.right + 10) }]}>
        <CockpitButton
          icon="settings-outline"
          label={zh ? '视频设置' : 'Video settings'}
          active={editMode}
          onPress={() => setEditMode(true)}
        />
        <CockpitButton
          icon="navigate-circle-outline"
          label={missionActive
            ? missionStateLabel(missionState, zh)
            : inspectionRuntimeState === 'starting'
              ? (zh ? '巡检准备中' : 'Preparing inspection')
              : (zh ? '巡检任务' : 'Inspection')}
          active={missionActive || inspectionRuntimeState === 'starting'}
          onPress={openInspectionPanel}
        />
        <CockpitButton icon="options-outline" label={zh ? '机器人动作' : 'Actions'} onPress={onOpenRobotActions} />
      </View>

      <View pointerEvents="none" style={styles.bottomCenterStatus}>
        <Text style={styles.bottomCenterTitle}>{scene === 'video' ? (zh ? '实时画面' : 'LIVE VIEW') : (zh ? '实时地图' : 'LIVE MAP')}</Text>
        <Text style={styles.bottomCenterValue}>
          {missionActive
            ? `${missionStateLabel(missionState, zh)} · ${Math.round(Math.max(0, Math.min(1, mission?.progress || 0)) * 100)}%`
            : (zh ? '左摇杆 X / Y · 右摇杆 YAW' : 'Left X / Y · Right YAW')}
        </Text>
      </View>

      {isDemo ? (
        <TouchableOpacity style={[styles.demoPill, { left: Math.max(12, insets.left + 10) }]} onPress={onExitDemo}>
          <Ionicons name="flask-outline" size={15} color={theme.colors.statusConnecting} />
          <Text style={styles.demoPillText}>{zh ? '演示模式：不会发送真实指令' : 'Demo: no hardware commands'}</Text>
          <Ionicons name="close" size={15} color={theme.colors.statusConnecting} />
        </TouchableOpacity>
      ) : null}

      {/* 让横屏侧栏的“布局管理”入口在全屏控制台中也真正可用。 */}
      <View style={styles.hiddenLayoutManager} pointerEvents="box-none">
        <LayoutManager />
      </View>

      <WidgetSettings
        visible={editMode}
        widgetName={zh ? '视频画面' : 'Video'}
        language={language}
        description={zh ? '选择机器人视频话题；保存后立即应用到控制页。' : 'Choose the robot video topic. Changes apply immediately after saving.'}
        configSchema={cameraSettingsSchema}
        config={cameraConfig}
        recommendedConfig={{
          topic: DEFAULTS.cameraTopic,
          source: 'transport',
          maxFps: 10,
          mjpegPort: DEFAULTS.mjpegPort,
        }}
        onConfigChange={(nextConfig) => {
          if (!cameraSelection) return;
          updateWidgetConfigInLayout(cameraSelection.layoutId, cameraSelection.node.id, nextConfig);
        }}
        onClose={() => setEditMode(false)}
      />

      <Modal visible={missionsOpen} transparent animationType="fade" onRequestClose={() => setMissionsOpen(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMissionsOpen(false)} />
          <View style={[styles.missionPanel, { paddingRight: Math.max(18, insets.right + 16) }]}>
            <View style={styles.panelHeader}>
              <View>
                <Text style={styles.panelTitle}>{zh ? '巡检任务' : 'Inspection mission'}</Text>
                <Text style={styles.panelSubtitle}>{zh ? '自动准备导航链路，就绪后选择路线' : 'Prepare navigation automatically, then select a route'}</Text>
              </View>
              <TouchableOpacity style={styles.panelClose} onPress={() => setMissionsOpen(false)}>
                <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
              </TouchableOpacity>
            </View>

            {!missionConnected ? (
              <View style={styles.panelEmpty}>
                <Ionicons name="cloud-offline-outline" size={34} color={theme.colors.textMuted} />
                <Text style={styles.panelEmptyText}>{isDemo ? (zh ? '演示模式不下发巡检任务' : 'Demo mode cannot dispatch missions') : (zh ? '请先连接真实机器人' : 'Connect a real robot first')}</Text>
              </View>
            ) : missionActive ? (
              <View style={styles.activeMissionCard}>
                <Text style={styles.activeMissionEyebrow}>{zh ? '当前任务' : 'ACTIVE MISSION'}</Text>
                <Text style={styles.activeMissionRoute}>{mission?.route_id || mission?.mission_id}</Text>
                <Text style={styles.activeMissionState}>{missionStateLabel(missionState, zh)} · {Math.round(Math.max(0, Math.min(1, mission?.progress || 0)) * 100)}%</Text>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, mission?.progress || 0)) * 100}%` }]} /></View>
                <View style={styles.missionControlRow}>
                  {missionState === MISSION_STATE.PAUSED ? (
                    <CockpitButton icon="play" label={zh ? '继续任务' : 'Resume'} onPress={() => transport && void runMissionControl((mid) => resumeMission(transport, mid))} />
                  ) : (
                    <CockpitButton icon="pause" label={zh ? '暂停任务' : 'Pause'} onPress={() => transport && void runMissionControl((mid) => pauseMission(transport, mid))} />
                  )}
                  <CockpitButton icon="stop-circle-outline" label={zh ? '停止任务' : 'Stop'} danger onPress={confirmCancelMission} />
                </View>
              </View>
            ) : !inspectionRuntimeReady ? (
              <View style={styles.panelEmpty}>
                {inspectionRuntimeState === 'starting' || inspectionRuntimeState === 'unknown' ? (
                  <ActivityIndicator size="large" color={theme.colors.accentPrimary} />
                ) : (
                  <Ionicons
                    name={inspectionRuntimeState === 'idle' || inspectionRuntimeState === 'switchable_navigation' ? 'refresh-circle-outline' : 'warning-outline'}
                    size={38}
                    color={inspectionRuntimeState === 'idle' || inspectionRuntimeState === 'switchable_navigation' ? theme.colors.statusConnecting : theme.colors.statusError}
                  />
                )}
                <Text style={styles.panelRuntimeTitle}>
                  {inspectionRuntimeState === 'starting'
                    ? (zh ? '正在准备巡检环境' : 'Preparing inspection runtime')
                    : inspectionRuntimeState === 'unknown'
                      ? (zh ? '正在等待 Bridge 状态' : 'Waiting for Bridge status')
                      : inspectionRuntimeState === 'idle' || inspectionRuntimeState === 'switchable_navigation'
                        ? (zh ? '巡检环境尚未启动' : 'Inspection runtime is not running')
                        : inspectionRuntimeState === 'disabled'
                          ? (zh ? '当前 Bridge 未启用巡检编排' : 'Inspection orchestration is disabled')
                          : (zh ? '巡检链路存在冲突' : 'Inspection runtime conflict')}
                </Text>
                <Text style={styles.panelEmptyText}>
                  {inspectionRuntimeState === 'starting'
                    ? (inspectionRuntimeStatus.startsWith('switching:')
                      ? (zh ? '正在停止单点导航并切换到巡检模式…' : 'Stopping point navigation and switching modes…')
                      : (zh ? '正在依次启动重定位、Planner 和任务管理器…' : 'Starting localization, Planner and Mission Manager…'))
                    : inspectionRuntimeState === 'partial'
                      ? (zh ? '检测到手工启动的残留进程或 Planner 模式不正确，请停止后重试。' : 'A manual residual process or wrong Planner mode was detected. Stop it and retry.')
                      : inspectionRuntimeState === 'error'
                        ? `${zh ? '机器人端错误' : 'Robot-side error'}：${inspectionRuntimeStatus || 'unknown'}`
                        : inspectionRuntimeState === 'unknown'
                          ? (zh ? '若持续无状态，请确认已启动最新版本 Robot Bridge。' : 'If this persists, start the latest Robot Bridge.')
                          : (zh ? '点击重试，由机器人端自动启动完整链路。' : 'Retry to start the complete robot-side runtime.')}
                </Text>
                {inspectionRuntimeState === 'idle' || inspectionRuntimeState === 'switchable_navigation' ? (
                  <TouchableOpacity style={styles.runtimeRetryButton} onPress={retryInspectionRuntime}>
                    <Ionicons name="play" size={17} color="#061014" />
                    <Text style={styles.dispatchButtonText}>{zh ? '重新启动巡检环境' : 'Retry runtime startup'}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : (
              <>
                <View style={styles.routeSectionHeader}>
                  <Text style={styles.routeSectionTitle}>{zh ? '可用巡检路线' : 'Available routes'}</Text>
                  <TouchableOpacity style={styles.refreshButton} onPress={refreshRoutes}>
                    <Ionicons name="refresh" size={17} color={theme.colors.accentPrimary} />
                    <Text style={styles.refreshText}>{zh ? '刷新' : 'Refresh'}</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView style={styles.routesList} contentContainerStyle={styles.routesContent} showsVerticalScrollIndicator={false}>
                  {!routesLoaded ? <Text style={styles.routeEmpty}>{zh ? '正在读取路线…' : 'Loading routes…'}</Text> : null}
                  {routesLoaded && routes.length === 0 ? <Text style={styles.routeEmpty}>{zh ? '机器人上还没有可用巡检路线' : 'No inspection routes found on the robot'}</Text> : null}
                  {routes.map((route) => {
                    const selected = selectedRouteId === route.routeId;
                    return (
                      <TouchableOpacity key={route.routeId} style={[styles.routeRow, selected && styles.routeRowSelected]} onPress={() => useMissionStore.getState().selectRoute(selected ? null : route.routeId)}>
                        <View style={[styles.routeIcon, selected && styles.routeIconSelected]}><Ionicons name="git-branch-outline" size={20} color={selected ? theme.colors.accentPrimary : theme.colors.textSecondary} /></View>
                        <View style={styles.routeCopy}>
                          <Text style={styles.routeName}>{route.routeId}</Text>
                          <Text style={styles.routeMeta}>{route.mapId ? `${zh ? '地图' : 'Map'}: ${route.mapId}` : (zh ? '未绑定地图' : 'No map binding')}</Text>
                        </View>
                        <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={selected ? theme.colors.accentPrimary : theme.colors.borderDefault} />
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <TouchableOpacity disabled={!selectedRouteId || dispatching} style={[styles.dispatchButton, (!selectedRouteId || dispatching) && styles.dispatchButtonDisabled]} onPress={dispatchSelectedRoute}>
                  <Ionicons name={dispatching ? 'hourglass-outline' : 'send'} size={18} color="#061014" />
                  <Text style={styles.dispatchButtonText}>{dispatching ? (zh ? '正在下发…' : 'Dispatching…') : (zh ? '开始巡检任务' : 'Start inspection')}</Text>
                </TouchableOpacity>
              </>
            )}
            {controlling ? <Text style={styles.panelNotice}>{zh ? '正在等待任务管理器响应…' : 'Waiting for Mission Manager…'}</Text> : null}
            {lastError ? <Text style={styles.panelError}>{lastError}</Text> : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#020607', overflow: 'hidden' },
  offlineBackground: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#061014' },
  offlineTitle: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: '700' },
  offlineMessage: { color: theme.colors.textMuted, fontSize: 13 },
  sceneShadeTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 92, backgroundColor: '#0206079A' },
  sceneShadeBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 150, backgroundColor: '#02060768' },
  reticle: { position: 'absolute', left: '50%', top: '50%', width: 42, height: 42, marginLeft: -21, marginTop: -21, borderRadius: 21, borderWidth: 1, borderColor: '#FFFFFF38' },
  reticleH: { position: 'absolute', width: 12, height: 1, backgroundColor: '#FFFFFF60', top: 20, left: 15 },
  reticleV: { position: 'absolute', width: 1, height: 12, backgroundColor: '#FFFFFF60', top: 15, left: 20 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, minHeight: 66, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingBottom: 8 },
  topGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cockpitButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 13, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF28', backgroundColor: '#071116CE' },
  cockpitButtonActive: { borderColor: theme.colors.accentPrimary + 'AA', backgroundColor: '#27515BDD' },
  cockpitButtonDanger: { borderColor: theme.colors.statusError + '99', backgroundColor: '#311519DD' },
  cockpitButtonText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: '700' },
  cockpitButtonDangerText: { color: theme.colors.statusError },
  connectionPill: { maxWidth: 230, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF22', backgroundColor: '#071116CE' },
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
  connectionLabel: { color: theme.colors.textPrimary, fontSize: 11, fontWeight: '700' },
  connectionUrl: { maxWidth: 170, color: theme.colors.textMuted, fontFamily: 'SpaceMono', fontSize: 8, marginTop: 1 },
  sceneSwitch: { flexDirection: 'row', padding: 3, borderRadius: 13, borderWidth: 1, borderColor: '#FFFFFF22', backgroundColor: '#071116D9' },
  sceneSwitchItem: { height: 38, minWidth: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 13, borderRadius: 10 },
  sceneSwitchItemActive: { backgroundColor: '#FFFFFF18' },
  sceneSwitchText: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' },
  sceneSwitchTextActive: { color: '#FFFFFF' },
  rightDock: { position: 'absolute', top: 92, flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  hiddenLayoutManager: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  bottomCenterStatus: { position: 'absolute', bottom: 15, left: '35%', right: '35%', minHeight: 41, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: '#FFFFFF18', backgroundColor: '#061014B8' },
  bottomCenterTitle: { color: theme.colors.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1 },
  bottomCenterValue: { color: theme.colors.textValue, fontFamily: 'SpaceMono', fontSize: 9, marginTop: 2 },
  demoPill: { position: 'absolute', bottom: 15, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38, paddingHorizontal: 11, borderRadius: 11, backgroundColor: '#2D2214DD', borderWidth: 1, borderColor: theme.colors.statusConnecting + '55' },
  demoPillText: { color: theme.colors.statusConnecting, fontSize: 10, fontWeight: '600' },
  modalOverlay: { flex: 1, alignItems: 'flex-end', backgroundColor: '#00000070' },
  missionPanel: { width: 420, maxWidth: '64%', height: '100%', paddingLeft: 18, paddingTop: 18, paddingBottom: 18, backgroundColor: '#0A151BEF', borderLeftWidth: 1, borderLeftColor: theme.colors.borderDefault },
  panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
  panelTitle: { color: theme.colors.textPrimary, fontSize: 19, fontWeight: '700' },
  panelSubtitle: { color: theme.colors.textMuted, fontSize: 11, marginTop: 3 },
  panelClose: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.bgSurface },
  panelEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  panelEmptyText: { color: theme.colors.textMuted, fontSize: 13 },
  panelRuntimeTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '700', marginTop: 4 },
  runtimeRetryButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 16, marginTop: 8, borderRadius: 12, backgroundColor: theme.colors.accentPrimary },
  routeSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 15, marginBottom: 8 },
  routeSectionTitle: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  refreshButton: { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 7 },
  refreshText: { color: theme.colors.accentPrimary, fontSize: 11, fontWeight: '600' },
  routesList: { flex: 1 },
  routesContent: { paddingBottom: 10 },
  routeEmpty: { color: theme.colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 35 },
  routeRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 7, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.borderSubtle, backgroundColor: '#FFFFFF08' },
  routeRowSelected: { borderColor: theme.colors.accentPrimary + '99', backgroundColor: theme.colors.accentPrimaryMuted },
  routeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.bgSurface },
  routeIconSelected: { backgroundColor: theme.colors.accentPrimaryMuted },
  routeCopy: { flex: 1, minWidth: 0 },
  routeName: { color: theme.colors.textValue, fontSize: 13, fontWeight: '700' },
  routeMeta: { color: theme.colors.textMuted, fontSize: 10, marginTop: 3 },
  dispatchButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 13, backgroundColor: theme.colors.accentPrimary },
  dispatchButtonDisabled: { opacity: 0.4 },
  dispatchButtonText: { color: '#061014', fontSize: 13, fontWeight: '800' },
  activeMissionCard: { marginTop: 18, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.accentPrimary + '66', backgroundColor: theme.colors.accentPrimaryMuted },
  activeMissionEyebrow: { color: theme.colors.accentPrimary, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  activeMissionRoute: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '700', marginTop: 8 },
  activeMissionState: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 4 },
  progressTrack: { height: 7, borderRadius: 4, backgroundColor: theme.colors.bgInset, overflow: 'hidden', marginVertical: 14 },
  progressFill: { height: '100%', backgroundColor: theme.colors.accentPrimary },
  missionControlRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  panelNotice: { color: theme.colors.statusConnecting, fontSize: 10, marginTop: 9 },
  panelError: { color: theme.colors.statusError, fontSize: 10, marginTop: 9 },
});
