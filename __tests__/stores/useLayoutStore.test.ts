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

import { migrateLayoutsForVbotHumble, useLayoutStore } from '../../stores/useLayoutStore';
import { createWidgetNode, createSplitNode } from '../../types/layout';

beforeEach(() => {
  useLayoutStore.getState().reset();
});

describe('useLayoutStore', () => {
  describe('VBot Humble migration', () => {
    it('moves legacy joystick defaults to /vel_cmd Twist', () => {
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

      const [migrated] = migrateLayoutsForVbotHumble([legacy]);
      expect(migrated.tree.type).toBe('widget');
      if (migrated.tree.type === 'widget') {
        expect(migrated.tree.config.topic).toBe('/vel_cmd');
        expect(migrated.tree.config.useTwistStamped).toBe(false);
        expect(migrated.tree.config.xAxisComponent).toBe('z');
        expect(migrated.tree.config.yAxisComponent).toBe('x');
      }
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

      const [migrated] = migrateLayoutsForVbotHumble([custom]);
      expect(migrated.tree).toEqual(custom.tree);
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
