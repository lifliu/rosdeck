import { useRosStore } from '../../stores/useRosStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FoxgloveTransport } from '../../lib/foxglove-transport';

// Reset store between tests
beforeEach(() => {
  jest.restoreAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue(null);
  (AsyncStorage.setItem as jest.Mock).mockClear();
  useRosStore.getState().reset();
});

describe('useRosStore', () => {
  describe('connection state', () => {
    it('starts disconnected with no URL', () => {
      const state = useRosStore.getState();
      expect(state.connection.status).toBe('disconnected');
      expect(state.connection.url).toBe('');
      expect(state.connection.ros).toBeNull();
      expect(state.connection.error).toBeNull();
    });

    it('setUrl updates the URL', () => {
      useRosStore.getState().setUrl('ws://192.168.1.50:9090');
      expect(useRosStore.getState().connection.url).toBe('ws://192.168.1.50:9090');
    });

    it('setConnectionStatus updates status and clears error on connect', () => {
      useRosStore.getState().setConnectionStatus('connected');
      const state = useRosStore.getState();
      expect(state.connection.status).toBe('connected');
      expect(state.connection.error).toBeNull();
    });

    it('setConnectionStatus sets error message on error', () => {
      useRosStore.getState().setConnectionStatus('error', 'Connection refused');
      const state = useRosStore.getState();
      expect(state.connection.status).toBe('error');
      expect(state.connection.error).toBe('Connection refused');
    });

    it.each([
      'ws://192.168.1.50:',
      'ws://192.168.1.50::8765',
    ])('rejects malformed URL %s before creating a transport', (url) => {
      useRosStore.getState().setTransportType('foxglove');
      useRosStore.getState().connectToUrl(url);

      const state = useRosStore.getState();
      expect(state.connection.status).toBe('error');
      expect(state.connection.error).toBe('Invalid WebSocket URL');
      expect(state.transport).toBeNull();
    });

    it('canonicalizes a bare Foxglove host before passing it to a transport', async () => {
      const connect = jest.spyOn(FoxgloveTransport.prototype, 'connect').mockResolvedValue();
      useRosStore.getState().setTransportType('foxglove');

      await (useRosStore.getState().connectToUrl(' 192.168.1.50 ') as any);

      expect(connect).toHaveBeenCalledWith('ws://192.168.1.50:8765');
      expect(useRosStore.getState().connection.url).toBe('ws://192.168.1.50:8765');
    });

    it('ignores a connection which finishes after the user disconnects', async () => {
      let finishConnect!: () => void;
      const pendingConnect = new Promise<void>((resolve) => { finishConnect = resolve; });
      jest.spyOn(FoxgloveTransport.prototype, 'connect').mockReturnValue(pendingConnect);
      useRosStore.getState().setTransportType('foxglove');

      const attempt = useRosStore.getState().connectToUrl('192.168.1.50') as any as Promise<void>;
      useRosStore.getState().disconnect();
      finishConnect();
      await attempt;

      expect(useRosStore.getState().connection.status).toBe('disconnected');
      expect(useRosStore.getState().savedConnections).toEqual([]);
    });

    it('ignores a late connection error after the user disconnects', async () => {
      let failConnect!: (error: Error) => void;
      const pendingConnect = new Promise<void>((_, reject) => { failConnect = reject; });
      jest.spyOn(FoxgloveTransport.prototype, 'connect').mockReturnValue(pendingConnect);
      useRosStore.getState().setTransportType('foxglove');

      const attempt = useRosStore.getState().connectToUrl('192.168.1.50') as any as Promise<void>;
      useRosStore.getState().disconnect();
      failConnect(new Error('late failure'));
      await attempt;

      expect(useRosStore.getState().connection.status).toBe('disconnected');
      expect(useRosStore.getState().connection.error).toBeNull();
    });

    it('disconnects the previous transport before replacing it', async () => {
      jest.spyOn(FoxgloveTransport.prototype, 'connect').mockResolvedValue();
      const disconnect = jest.spyOn(FoxgloveTransport.prototype, 'disconnect');
      useRosStore.getState().setTransportType('foxglove');

      await (useRosStore.getState().connectToUrl('192.168.1.50') as any);
      await (useRosStore.getState().connectToUrl('192.168.1.51') as any);

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(useRosStore.getState().connection.url).toBe('ws://192.168.1.51:8765');
    });
  });

  describe('transport state', () => {
    it('starts with null transport and rosbridge type', () => {
      const state = useRosStore.getState();
      expect(state.transport).toBeNull();
      expect(state.transportType).toBe('rosbridge');
    });

    it('setTransportType updates the transport type', () => {
      useRosStore.getState().setTransportType('foxglove');
      expect(useRosStore.getState().transportType).toBe('foxglove');
    });

    it('reset restores transport state', () => {
      useRosStore.getState().setTransportType('foxglove');
      useRosStore.getState().reset();
      const state = useRosStore.getState();
      expect(state.transport).toBeNull();
      expect(state.transportType).toBe('rosbridge');
    });
  });

  describe('saved connections', () => {
    it('starts with empty saved connections', () => {
      expect(useRosStore.getState().savedConnections).toEqual([]);
    });

    it('addSavedConnection adds a new connection', () => {
      useRosStore.getState().addSavedConnection('ws://192.168.1.50:9090', 'TurtleBot');
      const saved = useRosStore.getState().savedConnections;
      expect(saved).toHaveLength(1);
      expect(saved[0].url).toBe('ws://192.168.1.50:9090');
      expect(saved[0].name).toBe('TurtleBot');
    });

    it('addSavedConnection updates lastUsed if URL exists', () => {
      useRosStore.getState().addSavedConnection('ws://192.168.1.50:9090', 'TurtleBot');
      const firstTime = useRosStore.getState().savedConnections[0].lastUsed;
      useRosStore.getState().addSavedConnection('ws://192.168.1.50:9090');
      const saved = useRosStore.getState().savedConnections;
      expect(saved).toHaveLength(1);
      expect(saved[0].lastUsed).toBeGreaterThanOrEqual(firstTime);
    });

    it('removeSavedConnection removes by URL', () => {
      useRosStore.getState().addSavedConnection('ws://192.168.1.50:9090');
      useRosStore.getState().addSavedConnection('ws://10.0.0.1:9090');
      useRosStore.getState().removeSavedConnection('ws://192.168.1.50:9090');
      const saved = useRosStore.getState().savedConnections;
      expect(saved).toHaveLength(1);
      expect(saved[0].url).toBe('ws://10.0.0.1:9090');
    });

    it('migrates bare saved URLs and drops malformed saved records', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify([
        { url: ' 192.168.1.50 ', transport: 'foxglove', lastUsed: 123, name: 'Robot dog' },
        { url: 'robot.local', lastUsed: 100, name: 'Old name' },
        { url: 'ws://robot.local:9090', transport: 'rosbridge', lastUsed: 200, name: 'Latest' },
        { url: 'ws://192.168.1.50:', transport: 'rosbridge', lastUsed: 456 },
        { url: 42, transport: 'rosbridge', lastUsed: 789 },
        { url: 'robot.local', transport: 'invalid', lastUsed: 999 },
      ]));

      await useRosStore.getState().loadSavedConnections();

      expect(useRosStore.getState().savedConnections).toEqual([
        {
          url: 'ws://192.168.1.50:8765',
          transport: 'foxglove',
          lastUsed: 123,
          name: 'Robot dog',
        },
        {
          url: 'ws://robot.local:9090',
          transport: 'rosbridge',
          lastUsed: 200,
          name: 'Latest',
        },
      ]);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        'ros2mobile_saved_connections',
        JSON.stringify(useRosStore.getState().savedConnections),
      );
    });
  });

  describe('getTopics', () => {
    it('returns empty array when no transport', async () => {
      const topics = await useRosStore.getState().getTopics();
      expect(topics).toEqual([]);
    });
  });
});
