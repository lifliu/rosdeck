import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ConnectionStatus, SavedConnection } from '../types/ros';
import type { ConnectOptions, Transport, TransportType } from '../lib/transport';
import { RosbridgeTransport } from '../lib/rosbridge-transport';
import { FoxgloveTransport } from '../lib/foxglove-transport';
import { DemoTransport } from '../lib/demo-transport';
import { DEFAULTS } from '../constants/defaults';
import { buildWebSocketUrl } from '../lib/ros';
import { bestEffortReleaseControl } from '../lib/control-authority';
import { parseConnectionInput } from '../lib/connection-url';
import { usePairingStore } from './usePairingStore';

interface ConnectionState {
  url: string;
  status: ConnectionStatus;
  error: string | null;
  ros: any;
}

interface RosStore {
  connection: ConnectionState;
  transport: Transport | null;
  transportType: TransportType;
  savedConnections: SavedConnection[];
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  setUrl: (url: string) => void;
  setConnectionStatus: (status: ConnectionStatus, error?: string) => void;
  setRos: (ros: any) => void;
  setTransportType: (type: TransportType) => void;
  getTopics: () => Promise<Array<{ name: string; type: string }>>;
  addSavedConnection: (url: string, name?: string) => void;
  removeSavedConnection: (url: string) => void;
  loadSavedConnections: () => Promise<void>;
  restoreMostRecentConnection: () => Promise<void>;
  persistSavedConnections: () => Promise<void>;
  connectToUrl: (url: string, isReconnect?: boolean) => Promise<void>;
  handleDisconnect: () => void;
  disconnect: () => void;
  reset: () => void;
}

const initialConnection: ConnectionState = {
  url: '',
  status: 'disconnected',
  error: null,
  ros: null,
};

const STORAGE_KEY_CONNECTIONS = 'ros2mobile_saved_connections';

/**
 * Attaches the saved device-pairing login to a wss connection whose host
 * matches the pairing. ws:// (legacy bridges) and mismatched hosts never
 * send a login frame.
 */
function resolveLoginOptions(canonicalUrl: string): ConnectOptions | undefined {
  const parsed = parseConnectionInput(canonicalUrl);
  if (parsed.kind !== 'valid' || parsed.scheme !== 'wss') return undefined;
  const pairing = usePairingStore.getState().pairing;
  if (!pairing || pairing.host !== parsed.host) return undefined;
  return { login: { user: pairing.user, token: pairing.token } };
}

function normalizeSavedConnections(value: unknown): SavedConnection[] {
  if (!Array.isArray(value)) return [];

  const normalized: SavedConnection[] = [];
  const indexByUrl = new Map<string, number>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.url !== 'string') continue;
    if (candidate.transport !== undefined
      && candidate.transport !== 'rosbridge'
      && candidate.transport !== 'foxglove'
      && candidate.transport !== 'demo') continue;

    const transport = candidate.transport ?? 'rosbridge';
    const url = transport === 'demo'
      ? (/^demo:\/\/[^\s]+$/.test(candidate.url.trim()) ? candidate.url.trim() : null)
      : buildWebSocketUrl(candidate.url, transport);
    if (!url) continue;

    const connection: SavedConnection = {
      url,
      transport,
      lastUsed: typeof candidate.lastUsed === 'number' && Number.isFinite(candidate.lastUsed)
        ? candidate.lastUsed
        : 0,
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    };
    const existingIndex = indexByUrl.get(url);
    if (existingIndex === undefined) {
      indexByUrl.set(url, normalized.length);
      normalized.push(connection);
    } else if (connection.lastUsed >= normalized[existingIndex].lastUsed) {
      normalized[existingIndex] = connection;
    }
  }
  return normalized;
}

export const useRosStore = create<RosStore>((set, get) => ({
  connection: { ...initialConnection },
  transport: null,
  transportType: 'rosbridge',
  savedConnections: [],
  reconnectAttempts: 0,
  reconnectTimer: null,

  setUrl: (url) =>
    set((state) => ({ connection: { ...state.connection, url } })),

  setConnectionStatus: (status, error) =>
    set((state) => ({
      connection: {
        ...state.connection,
        status,
        error: status === 'error' ? (error ?? 'Unknown error') : null,
      },
    })),

  setRos: (ros) =>
    set((state) => ({ connection: { ...state.connection, ros } })),

  setTransportType: (type: TransportType) => set({ transportType: type }),

  getTopics: async () => {
    const { transport } = get();
    if (!transport) return [];
    return transport.getTopics();
  },

  addSavedConnection: (url, name) =>
    set((state) => {
      const transport = state.transportType;
      const existing = state.savedConnections.findIndex((c) => c.url === url);
      let updated: SavedConnection[];
      if (existing >= 0) {
        updated = [...state.savedConnections];
        updated[existing] = { ...updated[existing], lastUsed: Date.now(), transport, name: name ?? updated[existing].name };
      } else {
        updated = [...state.savedConnections, { url, name, transport, lastUsed: Date.now() }];
      }
      AsyncStorage.setItem(STORAGE_KEY_CONNECTIONS, JSON.stringify(updated)).catch(() => {});
      return { savedConnections: updated };
    }),

  removeSavedConnection: (url) =>
    set((state) => {
      const updated = state.savedConnections.filter((c) => c.url !== url);
      AsyncStorage.setItem(STORAGE_KEY_CONNECTIONS, JSON.stringify(updated)).catch(() => {});
      return { savedConnections: updated };
    }),

  loadSavedConnections: async () => {
    try {
      const connJson = await AsyncStorage.getItem(STORAGE_KEY_CONNECTIONS);
      if (!connJson) return;
      const parsed = JSON.parse(connJson);
      const savedConnections = normalizeSavedConnections(parsed);
      set({ savedConnections });
      if (JSON.stringify(savedConnections) !== JSON.stringify(parsed)) {
        await AsyncStorage.setItem(STORAGE_KEY_CONNECTIONS, JSON.stringify(savedConnections));
      }
    } catch {}
  },

  restoreMostRecentConnection: async () => {
    await get().loadSavedConnections();

    const state = get();
    // 异步读取存储期间，用户可能已经手动发起连接；此时绝不能用旧记录覆盖当前选择。
    if (state.connection.url || state.transport) return;

    const mostRecent = [...state.savedConnections]
      .filter((item) => item.transport !== 'demo')
      .sort((left, right) => right.lastUsed - left.lastUsed)[0];
    if (!mostRecent) return;

    set({ transportType: mostRecent.transport ?? 'rosbridge' });
    // 启动恢复属于自动连接。首次失败后继续走退避重连，网关晚于 APP 启动也能自行恢复。
    await get().connectToUrl(mostRecent.url, true);
  },

  persistSavedConnections: async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY_CONNECTIONS, JSON.stringify(get().savedConnections));
    } catch {}
  },

  connectToUrl: async (url: string, isReconnect = false) => {
    const { transportType, transport: previousTransport, reconnectTimer } = get();
    if (!isReconnect) {
      // A user-initiated connect supersedes any pending retry: cancel the
      // timer and start the backoff sequence over from the first attempt.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      set({ reconnectAttempts: 0, reconnectTimer: null });
    }
    const canonicalUrl = transportType === 'demo'
      ? url
      : buildWebSocketUrl(url, transportType === 'foxglove' ? 'foxglove' : 'rosbridge');
    if (!canonicalUrl) {
      set((s) => ({
        transport: null,
        connection: {
          ...s.connection,
          url,
          status: 'error',
          error: 'Invalid WebSocket URL',
          ros: null,
        },
      }));
      previousTransport?.disconnect();
      return;
    }

    const transport = transportType === 'demo'
      ? new DemoTransport()
      : transportType === 'foxglove'
        ? new FoxgloveTransport()
        : new RosbridgeTransport();

    transport.onStatus((status, error) => {
      if (get().transport !== transport) return;
      if (status === 'error') {
        // Terminal error from the transport (e.g. the gateway rejected the
        // login). Surface it; the reconnect loop must not retry it.
        set((s) => ({
          connection: { ...s.connection, status: 'error', error: error ?? 'Connection error' },
        }));
        return;
      }
      if (status === 'disconnected' && get().connection.status === 'connected') {
        get().handleDisconnect();
      }
    });

    set((s) => ({
      transport,
      connection: { ...s.connection, url: canonicalUrl, status: 'connecting', error: null },
    }));
    if (previousTransport && previousTransport !== transport) {
      previousTransport.disconnect();
    }

    try {
      const loginOptions = transportType === 'foxglove' ? resolveLoginOptions(canonicalUrl) : undefined;
      await transport.connect(canonicalUrl, loginOptions);
      if (get().transport !== transport) {
        transport.disconnect();
        return;
      }
      set((s) => ({
        connection: {
          ...s.connection,
          status: 'connected',
          ros: transportType === 'rosbridge' ? (transport as RosbridgeTransport).getRos() : null,
        },
        // A live connection resets the backoff sequence.
        reconnectAttempts: 0,
        reconnectTimer: null,
      }));
      if (!canonicalUrl.startsWith('demo://')) {
        get().addSavedConnection(canonicalUrl);
      }
    } catch (err: any) {
      if (get().transport !== transport) {
        transport.disconnect();
        return;
      }
      set((s) => ({
        connection: { ...s.connection, status: 'error', error: err?.message || 'Connection failed' },
      }));
      if (isReconnect) {
        // A failed retry never reaches the onStatus 'disconnected' path
        // (the socket never connected), so re-arm the retry loop here or
        // it dies after one failed attempt.
        get().handleDisconnect();
      }
    }
  },

  handleDisconnect: () => {
    const state = get();
    // 演示连接不重连；空地址或已有定时器时也不重复调度，防止并发创建 WebSocket。
    if (!state.connection.url || state.connection.url.startsWith('demo://') || state.reconnectTimer) return;
    const exponent = Math.min(
      state.reconnectAttempts,
      DEFAULTS.maxReconnectBackoffExponent,
    );
    const delay = Math.min(
      DEFAULTS.reconnectBackoffBase * Math.pow(2, exponent),
      DEFAULTS.reconnectBackoffMax
    );
    const timer = setTimeout(() => {
      // 先清掉已触发的定时器，失败回调才能为下一轮重新调度。
      set((s) => ({
        reconnectAttempts: Math.min(
          s.reconnectAttempts + 1,
          DEFAULTS.maxReconnectBackoffExponent,
        ),
        reconnectTimer: null,
      }));
      get().connectToUrl(state.connection.url, true);
    }, delay);
    set((current) => ({
      reconnectTimer: timer,
      connection: {
        ...current.connection,
        status: 'disconnected',
        error: null,
        ros: null,
      },
    }));
  },

  disconnect: () => {
    const state = get();
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    // Clear state first so the onStatus callback won't trigger auto-reconnect
    const transport = state.transport;
    bestEffortReleaseControl(transport);
    set({
      transport: null,
      connection: { ...initialConnection },
      reconnectAttempts: 0,
      reconnectTimer: null,
    });
    if (transport) {
      transport.disconnect();
    }
  },

  reset: () =>
    set({
      connection: { ...initialConnection },
      transport: null,
      transportType: 'rosbridge',
      savedConnections: [],
      reconnectAttempts: 0,
      reconnectTimer: null,
    }),
}));
