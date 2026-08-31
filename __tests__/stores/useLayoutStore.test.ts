jest.mock('../../widgets/registry', () => ({
  getWidget: (type: string) => ({
    type,
    name: type,
    icon: 'icon',
    category: 'control',
    supportedMessageTypes: [],
    defaultConfig: {},
    component: () => null,
  }),
}));

import {
  migrateLayoutsForUnifiedTeleop,
  migrateLegacyTeleopForUnifiedRobot,
  useLayoutStore,
} from '../../stores/useLayoutStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createWidgetNode, createSplitNode } from '../../types/layout';
import { buildDefaultLayouts } from '../../constants/presets';

beforeEach(() => {
  (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue(null);
  (AsyncStorage.setItem as jest.Mock).mockReset().mockResolvedValue(undefined);
  useLayoutStore.getState().reset();
});

describe('useLayoutStore', () => {
  describe('unified teleop migration', () => {
    it('moves the upstream /cmd_vel default to unified TwistStamped teleop', () => {
      const legacy = {
        id: 'legacy',
        name: 'Legacy',
        tree: createWidgetNode('joystick', {
          topic: '/cmd_vel',
          useTwistStamped: true,
          xAxisGroup: 'angular',
          xAxisComponent: 'z',
          yAxisGroup: 'linear',
          yAxisComponent: 'x',
        }),
      };

      const [migrated] = migrateLayoutsForUnifiedTeleop([legacy]);
      expect(migrated.tree.type).toBe('widget');
      if (migrated.tree.type === 'widget') {
        expect(migrated.tree.config.topic).toBe('/omni/cmd_vel/teleop');
        expect(migrated.tree.config.useTwistStamped).toBe(true);
        expect(migrated.tree.config.requireLocoMode).toBe(true);
        expect(migrated.tree.config.xAxisComponent).toBe('z');
        expect(migrated.tree.config.yAxisComponent).toBe('x');
      }
      expect(migrateLayoutsForUnifiedTeleop([legacy]).some((layout) => layout.id === 'mapping-3d'))
        .toBe(true);
    });

    it('retains /vel_cmd as the old VBot compatibility path', () => {
      const legacyVbot = {
        id: 'vbot',
        name: 'VBot',
        tree: createWidgetNode('joystick', {
          topic: '/vel_cmd',
          useTwistStamped: true,
          requireLocoMode: false,
        }),
      };

      const [migrated] = migrateLayoutsForUnifiedTeleop([legacyVbot]);
      expect(migrated.tree.type).toBe('widget');
      if (migrated.tree.type === 'widget') {
        expect(migrated.tree.config.topic).toBe('/vel_cmd');
        expect(migrated.tree.config.useTwistStamped).toBe(false);
        expect(migrated.tree.config.requireLocoMode).toBe(true);
      }
    });

    it('upgrades /vel_cmd only after the connected graph proves unified teleop support', () => {
      const legacyVbot = {
        id: 'vbot',
        name: 'VBot',
        tree: createWidgetNode('joystick', {
          topic: '/vel_cmd',
          useTwistStamped: false,
        }),
      };

      const result = migrateLegacyTeleopForUnifiedRobot([legacyVbot]);
      expect(result.changed).toBe(true);
      expect(result.layouts[0].tree.type).toBe('widget');
      if (result.layouts[0].tree.type === 'widget') {
        expect(result.layouts[0].tree.config).toMatchObject({
          topic: '/omni/cmd_vel/teleop',
          useTwistStamped: true,
          requireLocoMode: true,
        });
      }
    });

    it('leaves custom joystick topics unchanged during capability migration', () => {
      const custom = {
        id: 'custom',
        name: 'Custom',
        tree: createWidgetNode('joystick', { topic: '/custom_velocity' }),
      };
      const result = migrateLegacyTeleopForUnifiedRobot([custom]);
      expect(result.changed).toBe(false);
      expect(result.layouts[0]).toBe(custom);
    });

    it('preserves an explicitly customized velocity topic', () => {
      const custom = {
        id: 'custom',
        name: 'Custom',
        tree: createWidgetNode('joystick', {
          topic: '/custom_velocity',
          useTwistStamped: true,
        }),
      };

      const [migrated] = migrateLayoutsForUnifiedTeleop([custom]);
      expect(migrated.tree).toEqual(custom.tree);
    });

    it('moves the old point-cloud reference frame to lidar_frame', () => {
      const legacy = {
        id: 'mapping-3d',
        name: '3D Mapping',
        tree: createWidgetNode('pointcloud3d', {
          topic: '/cloud_registered',
          robotFrame: 'base_link',
        }),
      };
      const [migrated] = migrateLayoutsForUnifiedTeleop([legacy]);
      expect(migrated.tree.type).toBe('widget');
      if (migrated.tree.type === 'widget') {
        expect(migrated.tree.config.robotFrame).toBe('lidar_frame');
        expect(migrated.tree.config.mapFrame).toBe('map_frame');
      }
    });

    it('seeds new layouts with unified TwistStamped teleop', () => {
      const drive = buildDefaultLayouts().find((layout) => layout.id === 'drive');
      expect(drive?.tree.type).toBe('widget');
      if (drive?.tree.type === 'widget') {
        expect(drive.tree.config.topic).toBe('/omni/cmd_vel/teleop');
        expect(drive.tree.config.useTwistStamped).toBe(true);
        expect(drive.tree.config.requireLocoMode).toBe(true);
      }
    });
  });

  describe('initForRobot', () => {
    it('seeds default layouts for a new robot', async () => {
      await useLayoutStore.getState().initForRobot('ws://192.168.1.1:9090');
      const state = useLayoutStore.getState();
      expect(state.layouts.length).toBeGreaterThan(0);
      expect(state.activeLayoutId).toBe('drive-camera');
      expect(state.robotUrl).toBe('ws://192.168.1.1:9090');
    });

    it('ignores a slow stale initialization after switching robots', async () => {
      let resolveFirst: ((value: string | null) => void) | undefined;
      (AsyncStorage.getItem as jest.Mock)
        .mockImplementationOnce(() => new Promise<string | null>((resolve) => {
          resolveFirst = resolve;
        }))
        .mockResolvedValueOnce(null);

      const first = useLayoutStore.getState().initForRobot('ws://robot-a:9090');
      const second = useLayoutStore.getState().initForRobot('ws://robot-b:9090');
      expect(await second).toBe(true);
      resolveFirst?.(null);
      expect(await first).toBe(false);
      expect(useLayoutStore.getState().robotUrl).toBe('ws://robot-b:9090');
    });
  });

  describe('setActiveLayout', () => {
    it('switches the active layout', async () => {
      await useLayoutStore.getState().initForRobot('ws://192.168.1.1:9090');
      useLayoutStore.getState().setActiveLayout('drive');
      expect(useLayoutStore.getState().activeLayoutId).toBe('drive');
    });
  });

  describe('updateLayoutTree', () => {
    it('updates the tree for the active layout', async () => {
      await useLayoutStore.getState().initForRobot('ws://192.168.1.1:9090');
      const newTree = createWidgetNode('joystick', {});
      useLayoutStore.getState().updateLayoutTree(newTree);
      const active = useLayoutStore.getState().getActiveLayout();
      expect(active?.tree).toBe(newTree);
    });
  });

  describe('addLayout', () => {
    it('adds a new custom layout', async () => {
      await useLayoutStore.getState().initForRobot('ws://192.168.1.1:9090');
      const before = useLayoutStore.getState().layouts.length;
      useLayoutStore.getState().addLayout('My Layout', createWidgetNode('camera', {}));
      expect(useLayoutStore.getState().layouts.length).toBe(before + 1);
    });
  });

  describe('removeLayout', () => {
    it('removes a layout and switches to another', async () => {
      await useLayoutStore.getState().initForRobot('ws://192.168.1.1:9090');
      useLayoutStore.getState().addLayout('Custom', createWidgetNode('camera', {}));
      const custom = useLayoutStore.getState().layouts.find((l) => l.name === 'Custom')!;
      useLayoutStore.getState().setActiveLayout(custom.id);
      useLayoutStore.getState().removeLayout(custom.id);
      expect(useLayoutStore.getState().layouts.find((l) => l.id === custom.id)).toBeUndefined();
      expect(useLayoutStore.getState().activeLayoutId).toBeDefined();
    });
  });

  describe('editMode', () => {
    it('toggles edit mode', () => {
      expect(useLayoutStore.getState().editMode).toBe(false);
      useLayoutStore.getState().setEditMode(true);
      expect(useLayoutStore.getState().editMode).toBe(true);
    });
  });

  describe('splitPane', () => {
    it('splits a widget node into two panes', async () => {
      await useLayoutStore.getState().initForRobot('ws://test:9090');
      useLayoutStore.getState().setActiveLayout('drive');
      const layout = useLayoutStore.getState().getActiveLayout()!;
      const nodeId = layout.tree.id;

      useLayoutStore.getState().splitPane(nodeId, 'vertical', 'camera');

      const updated = useLayoutStore.getState().getActiveLayout()!;
      expect(updated.tree.type).toBe('split');
      if (updated.tree.type === 'split') {
        expect(updated.tree.direction).toBe('vertical');
        expect(updated.tree.children[0].type).toBe('widget');
        expect(updated.tree.children[1].type).toBe('widget');
      }
    });
  });

  describe('removePane', () => {
    it('removes a pane and promotes sibling', async () => {
      await useLayoutStore.getState().initForRobot('ws://test:9090');
      useLayoutStore.getState().setActiveLayout('drive-camera');
      const layout = useLayoutStore.getState().getActiveLayout()!;
      if (layout.tree.type === 'split') {
        const cameraId = layout.tree.children[0].id;
        useLayoutStore.getState().removePane(cameraId);
        const updated = useLayoutStore.getState().getActiveLayout()!;
        expect(updated.tree.type).toBe('widget');
      }
    });
  });
});
