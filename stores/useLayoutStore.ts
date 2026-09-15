import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  type LayoutNode,
  type SavedLayout,
  createWidgetNode,
  createSplitNode,
  findNode,
  replaceNode,
  removeNode,
} from '../types/layout';
import { buildDefaultLayouts } from '../constants/presets';
import { DEFAULTS } from '../constants/defaults';
import { OMNI_BASE_FRAME, OMNI_MAP_FRAME, OMNI_ODOM_FRAME } from '../lib/frames';
import { getWidget } from '../widgets/registry';
import {
  LEGACY_VBOT_TELEOP_TOPIC,
  LEGACY_OMNI_TELEOP_TOPIC,
  OMNI_TELEOP_TOPIC,
  UPSTREAM_CMD_VEL_TOPIC,
} from '../lib/teleop';

const STORAGE_KEY_PREFIX = 'ros2mobile_layouts_';
const LAYOUT_SCHEMA_VERSION = 9;
let latestLayoutInitRequest = 0;

const LEGACY_DEFAULT_CAMERA_TOPICS = new Set([
  '/camera/image_raw/compressed',
  '/image_raw/compressed',
  '/image_left_raw/h265_undistort',
]);

async function persistLayoutSnapshot(
  robotUrl: string,
  layouts: SavedLayout[],
  activeLayoutId: string,
): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY_PREFIX + robotUrl,
    JSON.stringify({ schemaVersion: LAYOUT_SCHEMA_VERSION, layouts, activeLayoutId }),
  );
}

/**
 * Move unconfigured/upstream joystick defaults to the unified teleop input.
 * An explicit `/vel_cmd` is retained for old VBot profiles that do not expose
 * cmd_vel_arbiter yet.
 */
export function migrateLayoutsForUnifiedTeleop(layouts: SavedLayout[]): SavedLayout[] {
  const migrateNode = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      return {
        ...node,
        children: [migrateNode(node.children[0]), migrateNode(node.children[1])],
      };
    }
    if (node.widgetType !== 'joystick') return node;

    const topic = node.config?.topic;
    if (topic === LEGACY_VBOT_TELEOP_TOPIC) {
      return {
        ...node,
        config: {
          ...node.config,
          topic: LEGACY_VBOT_TELEOP_TOPIC,
          useTwistStamped: false,
          requireLocoMode: true,
        },
      };
    }
    if (topic === OMNI_TELEOP_TOPIC || topic === LEGACY_OMNI_TELEOP_TOPIC) {
      return {
        ...node,
        config: {
          ...node.config,
          topic: OMNI_TELEOP_TOPIC,
          useTwistStamped: false,
          requireLocoMode: true,
        },
      };
    }
    const usesUpstreamDefault = !topic || topic === UPSTREAM_CMD_VEL_TOPIC;
    if (!usesUpstreamDefault) return node;

    return {
      ...node,
      config: {
        ...node.config,
        topic: DEFAULTS.cmdVelTopic,
        useTwistStamped: DEFAULTS.cmdVelUseTwistStamped,
        requireLocoMode: true,
      },
    };
  };

  const migrated = layouts.map((layout) => ({ ...layout, tree: migrateNode(layout.tree) }));
  if (!migrated.some((layout) => layout.id === 'mapping-3d')) {
    const mappingLayout = buildDefaultLayouts().find((layout) => layout.id === 'mapping-3d');
    if (mappingLayout) migrated.push(mappingLayout);
  }
  return migrated;
}

/**
 * 将历史内置 frame 默认值迁移到 omni_tf_manager 的 canonical TF 树。
 *
 * 只改写旧产品默认值；用户明确填写的自定义 frame 保持原样。主控制台在
 * 导航选点时还会拒绝非 canonical frame，避免“只换 frame 标签、不做变换”。
 */
export function migrateLayoutsForCanonicalFrames(layouts: SavedLayout[]): SavedLayout[] {
  const migrateNode = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      const first = migrateNode(node.children[0]);
      const second = migrateNode(node.children[1]);
      return first === node.children[0] && second === node.children[1]
        ? node
        : { ...node, children: [first, second] };
    }

    const config = node.config ?? {};
    let nextConfig = config;
    const setValue = (key: string, value: unknown) => {
      if (nextConfig === config) nextConfig = { ...config };
      nextConfig[key] = value;
    };

    if (node.widgetType === 'map') {
      if (!config.mapFrame || config.mapFrame === 'map') {
        setValue('mapFrame', OMNI_MAP_FRAME);
      }
      if (!config.odomFrame || config.odomFrame === 'odom') {
        setValue('odomFrame', OMNI_ODOM_FRAME);
      }
      if (!config.robotFrame || config.robotFrame === 'base_link') {
        setValue('robotFrame', OMNI_BASE_FRAME);
      }
    } else if (node.widgetType === 'pointcloud3d') {
      if (!config.topic || config.topic === '/cloud_registered') {
        setValue('topic', '/cloud_registered_global');
      }
      if (!config.mapFrame || config.mapFrame === 'map' || config.mapFrame === 'map_frame') {
        setValue('mapFrame', OMNI_MAP_FRAME);
      }
      if (!config.robotFrame || config.robotFrame === 'base_link' ||
          config.robotFrame === 'lidar_frame') {
        setValue('robotFrame', OMNI_BASE_FRAME);
      }
      if (!config.odomTopic) setValue('odomTopic', '/Odometry');
      if (!config.viewMeters) setValue('viewMeters', 20);
    } else if (node.widgetType === 'joystick' &&
        (!config.frameId || config.frameId === 'base_link')) {
      setValue('frameId', OMNI_BASE_FRAME);
    }

    return nextConfig === config ? node : { ...node, config: nextConfig };
  };

  return layouts.map((layout) => {
    const tree = migrateNode(layout.tree);
    return tree === layout.tree ? layout : { ...layout, tree };
  });
}

/**
 * 将旧版本内置的相机配置迁移到产品规范话题。
 *
 * 这里只识别历史默认值；用户手工填写的自定义话题和传输方式必须原样保留。
 * Foxglove 直连可直接传输 CompressedImage，不依赖容易与业务后端端口冲突的
 * web_video_server/MJPEG 服务。
 */
export function migrateLayoutsForCanonicalCamera(layouts: SavedLayout[]): SavedLayout[] {
  const migrateNode = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      return {
        ...node,
        children: [migrateNode(node.children[0]), migrateNode(node.children[1])],
      };
    }
    if (node.widgetType !== 'camera') return node;

    const topic = node.config?.topic;
    if (topic && !LEGACY_DEFAULT_CAMERA_TOPICS.has(topic)) return node;
    return {
      ...node,
      config: {
        ...node.config,
        topic: DEFAULTS.cameraTopic,
        source: 'transport',
        maxFps: node.config?.maxFps ?? 10,
      },
    };
  };

  return layouts.map((layout) => ({ ...layout, tree: migrateNode(layout.tree) }));
}

/** @deprecated Use migrateLayoutsForUnifiedTeleop. */
export const migrateLayoutsForVbotHumble = migrateLayoutsForUnifiedTeleop;

/**
 * A schema migration cannot distinguish the old default `/vel_cmd` from an
 * explicit VBot choice. Once the connected graph proves that the unified
 * arbiter input exists, it is safe to upgrade those legacy joystick entries.
 */
export function migrateLegacyTeleopForUnifiedRobot(
  layouts: SavedLayout[],
): { layouts: SavedLayout[]; changed: boolean } {
  let changed = false;
  const migrateNode = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      const first = migrateNode(node.children[0]);
      const second = migrateNode(node.children[1]);
      if (first === node.children[0] && second === node.children[1]) return node;
      return { ...node, children: [first, second] };
    }
    if (node.widgetType !== 'joystick' || node.config?.topic !== LEGACY_VBOT_TELEOP_TOPIC) {
      return node;
    }
    changed = true;
    return {
      ...node,
      config: {
        ...node.config,
        topic: OMNI_TELEOP_TOPIC,
        useTwistStamped: false,
        requireLocoMode: true,
      },
    };
  };

  const migrated = layouts.map((layout) => {
    const tree = migrateNode(layout.tree);
    return tree === layout.tree ? layout : { ...layout, tree };
  });
  return { layouts: migrated, changed };
}

/** Apply the discovered legacy VBot input to built-in defaults in every layout,
 * including the 3D mapping layout. Explicit custom topics and speed settings survive.
 */
export function adaptDefaultTeleopForVbot(
  layouts: SavedLayout[],
): { layouts: SavedLayout[]; changed: boolean } {
  let changed = false;
  const adapt = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') {
      const first = adapt(node.children[0]);
      const second = adapt(node.children[1]);
      return first === node.children[0] && second === node.children[1]
        ? node : { ...node, children: [first, second] };
    }
    if (node.widgetType !== 'joystick' ||
      ![undefined, '', OMNI_TELEOP_TOPIC, LEGACY_OMNI_TELEOP_TOPIC, UPSTREAM_CMD_VEL_TOPIC]
        .includes(node.config?.topic)) return node;
    changed = true;
    return { ...node, config: {
      ...node.config, topic: LEGACY_VBOT_TELEOP_TOPIC,
      useTwistStamped: false, requireLocoMode: true,
    } };
  };
  return { layouts: layouts.map((layout) => {
    const tree = adapt(layout.tree);
    return tree === layout.tree ? layout : { ...layout, tree };
  }), changed };
}

interface LayoutState {
  robotUrl: string | null;
  layouts: SavedLayout[];
  activeLayoutId: string;
  editMode: boolean;
  layoutListOpen: boolean;

  initForRobot: (url: string) => Promise<boolean>;
  migrateLegacyTeleopForUnifiedRobot: (expectedRobotUrl: string) => Promise<boolean>;
  adaptDefaultTeleopForVbot: (expectedRobotUrl: string) => Promise<boolean>;
  setActiveLayout: (id: string) => void;
  getActiveLayout: () => SavedLayout | undefined;
  updateLayoutTree: (tree: LayoutNode) => void;
  addLayout: (name: string, tree: LayoutNode) => void;
  removeLayout: (id: string) => void;
  renameLayout: (id: string, name: string) => void;
  setEditMode: (editing: boolean) => void;
  splitPane: (nodeId: string, direction: 'horizontal' | 'vertical', widgetType: string) => void;
  removePane: (nodeId: string) => void;
  updateWidgetConfig: (nodeId: string, config: Record<string, any>) => void;
  updateWidgetConfigInLayout: (layoutId: string, nodeId: string, config: Record<string, any>) => void;
  swapWidget: (nodeId: string, widgetType: string) => void;
  swapChildren: (splitNodeId: string) => void;
  updateSplitRatio: (nodeId: string, ratio: number) => void;
  persist: () => Promise<void>;
  reset: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  robotUrl: null,
  layouts: [],
  activeLayoutId: '',
  editMode: false,
  layoutListOpen: false,

  initForRobot: async (url: string) => {
    const request = ++latestLayoutInitRequest;
    const key = STORAGE_KEY_PREFIX + url;
    try {
      const stored = await AsyncStorage.getItem(key);
      if (request !== latestLayoutInitRequest) return false;
      if (stored) {
        const data = JSON.parse(stored);
        const needsMigration = data.schemaVersion !== LAYOUT_SCHEMA_VERSION;
        const layouts = needsMigration
          ? migrateLayoutsForCanonicalFrames(
            migrateLayoutsForCanonicalCamera(
              migrateLayoutsForUnifiedTeleop(data.layouts ?? []),
            ),
          )
          : data.layouts;
        const activeLayoutId = needsMigration && url.startsWith('demo://') && data.activeLayoutId === 'dashboard'
          ? 'drive-camera'
          : data.activeLayoutId;
        set({ robotUrl: url, layouts, activeLayoutId });
        if (needsMigration) {
          await persistLayoutSnapshot(url, layouts, activeLayoutId);
        }
        return true;
      }
    } catch {}
    if (request !== latestLayoutInitRequest) return false;
    const layouts = buildDefaultLayouts();
    const defaultLayoutId = url.startsWith('demo://') ? 'dashboard' : 'drive-camera';
    set({ robotUrl: url, layouts, activeLayoutId: defaultLayoutId });
    await persistLayoutSnapshot(url, layouts, defaultLayoutId);
    return true;
  },

  migrateLegacyTeleopForUnifiedRobot: async (expectedRobotUrl: string) => {
    if (get().robotUrl !== expectedRobotUrl) return false;
    const result = migrateLegacyTeleopForUnifiedRobot(get().layouts);
    if (!result.changed) return false;
    set({ layouts: result.layouts });
    if (get().robotUrl !== expectedRobotUrl) return false;
    await persistLayoutSnapshot(expectedRobotUrl, result.layouts, get().activeLayoutId);
    return true;
  },

  adaptDefaultTeleopForVbot: async (expectedRobotUrl: string) => {
    if (get().robotUrl !== expectedRobotUrl) return false;
    const result = adaptDefaultTeleopForVbot(get().layouts);
    if (!result.changed) return false;
    set({ layouts: result.layouts });
    if (get().robotUrl !== expectedRobotUrl) return false;
    await persistLayoutSnapshot(expectedRobotUrl, result.layouts, get().activeLayoutId);
    return true;
  },

  setActiveLayout: (id: string) => {
    set({ activeLayoutId: id });
    get().persist();
  },

  getActiveLayout: () => {
    const { layouts, activeLayoutId } = get();
    return layouts.find((l) => l.id === activeLayoutId);
  },

  updateLayoutTree: (tree: LayoutNode) => {
    const { activeLayoutId } = get();
    set((state) => ({
      layouts: state.layouts.map((l) =>
        l.id === activeLayoutId ? { ...l, tree } : l
      ),
    }));
    get().persist();
  },

  addLayout: (name: string, tree: LayoutNode) => {
    const id = `custom_${Date.now()}`;
    set((state) => ({
      layouts: [...state.layouts, { id, name, tree }],
      activeLayoutId: id,
    }));
    get().persist();
  },

  removeLayout: (id: string) => {
    const { layouts, activeLayoutId } = get();
    const filtered = layouts.filter((l) => l.id !== id);
    const newActive = id === activeLayoutId
      ? (filtered[0]?.id || '')
      : activeLayoutId;
    set({ layouts: filtered, activeLayoutId: newActive });
    get().persist();
  },

  renameLayout: (id: string, name: string) => {
    set((state) => ({
      layouts: state.layouts.map((l) =>
        l.id === id ? { ...l, name } : l
      ),
    }));
    get().persist();
  },

  setEditMode: (editing: boolean) => set({ editMode: editing }),

  splitPane: (nodeId: string, direction: 'horizontal' | 'vertical', widgetType: string) => {
    const layout = get().getActiveLayout();
    if (!layout) return;
    const origNode = findNode(layout.tree, nodeId);
    if (!origNode) return;
    const widget = getWidget(widgetType);
    const newWidget = createWidgetNode(widgetType, widget?.defaultConfig || {});
    const splitNode = createSplitNode(direction, origNode, newWidget);
    const updatedTree = replaceNode(layout.tree, nodeId, splitNode);
    get().updateLayoutTree(updatedTree);
  },

  removePane: (nodeId: string) => {
    const layout = get().getActiveLayout();
    if (!layout) return;
    const newTree = removeNode(layout.tree, nodeId);
    if (newTree) {
      get().updateLayoutTree(newTree);
    }
  },

  updateWidgetConfig: (nodeId: string, config: Record<string, any>) => {
    const layoutId = get().activeLayoutId;
    if (!layoutId) return;
    get().updateWidgetConfigInLayout(layoutId, nodeId, config);
  },

  updateWidgetConfigInLayout: (layoutId: string, nodeId: string, config: Record<string, any>) => {
    const layout = get().layouts.find((item) => item.id === layoutId);
    if (!layout) return;
    const updateConfig = (node: LayoutNode): LayoutNode => {
      if (node.id === nodeId && node.type === 'widget') {
        return { ...node, config };
      }
      if (node.type === 'split') {
        return { ...node, children: [updateConfig(node.children[0]), updateConfig(node.children[1])] };
      }
      return node;
    };
    const updatedTree = updateConfig(layout.tree);
    set((state) => ({
      layouts: state.layouts.map((item) => (
        item.id === layoutId ? { ...item, tree: updatedTree } : item
      )),
    }));
    void get().persist();
  },

  swapWidget: (nodeId: string, widgetType: string) => {
    const layout = get().getActiveLayout();
    if (!layout) return;
    const widget = getWidget(widgetType);
    const newNode = createWidgetNode(widgetType, widget?.defaultConfig || {});
    const updatedTree = replaceNode(layout.tree, nodeId, newNode);
    get().updateLayoutTree(updatedTree);
  },

  swapChildren: (splitNodeId: string) => {
    const layout = get().getActiveLayout();
    if (!layout) return;
    const swap = (node: LayoutNode): LayoutNode => {
      if (node.id === splitNodeId && node.type === 'split') {
        return { ...node, ratio: 1 - node.ratio, children: [node.children[1], node.children[0]] };
      }
      if (node.type === 'split') {
        return { ...node, children: [swap(node.children[0]), swap(node.children[1])] };
      }
      return node;
    };
    get().updateLayoutTree(swap(layout.tree));
  },

  updateSplitRatio: (nodeId: string, ratio: number) => {
    const layout = get().getActiveLayout();
    if (!layout) return;
    const updateRatio = (node: LayoutNode): LayoutNode => {
      if (node.id === nodeId && node.type === 'split') {
        return { ...node, ratio };
      }
      if (node.type === 'split') {
        return {
          ...node,
          children: [updateRatio(node.children[0]), updateRatio(node.children[1])],
        };
      }
      return node;
    };
    get().updateLayoutTree(updateRatio(layout.tree));
  },

  persist: async () => {
    const { robotUrl, layouts, activeLayoutId } = get();
    if (!robotUrl) return;
    await persistLayoutSnapshot(robotUrl, layouts, activeLayoutId);
  },

  reset: () => {
    ++latestLayoutInitRequest;
    set({ robotUrl: null, layouts: [], activeLayoutId: '', editMode: false, layoutListOpen: false });
  },
}));
