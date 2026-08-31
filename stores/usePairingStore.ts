import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseConnectionInput } from '../lib/connection-url';

const STORAGE_KEY = 'omnideck_pairing';

export interface DevicePairing {
  /** Bare hostname of the gateway (no scheme, no port). */
  host: string;
  user: string;
  token: string;
  /** SPKI SHA-256 pin shown by the robot (`omni-auth show-pairing`). */
  pin?: string;
}

interface PairingState {
  pairing: DevicePairing | null;
  loaded: boolean;
  load: () => Promise<void>;
  save: (pairing: DevicePairing) => void;
  clear: () => void;
}

function normalizePairing(value: unknown): DevicePairing | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.host !== 'string' || typeof candidate.user !== 'string'
    || typeof candidate.token !== 'string') return null;
  const host = candidate.host.trim();
  const user = candidate.user.trim();
  const token = candidate.token.trim();
  if (!host || !user || !token) return null;
  const pairing: DevicePairing = { host, user, token };
  if (typeof candidate.pin === 'string' && candidate.pin.trim()) {
    pairing.pin = candidate.pin.trim();
  }
  return pairing;
}

/**
 * Accepts "192.168.1.50", "192.168.1.50:8765", or "wss://192.168.1.50:8765"
 * and returns the bare hostname. Pairing is wss-only, so an explicit
 * `ws://` scheme is rejected.
 */
export function normalizePairingHost(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const parsed = parseConnectionInput(value);
  if (parsed.kind !== 'valid') return null;
  if (parsed.explicitScheme && parsed.scheme === 'ws') return null;
  return parsed.host;
}

export const usePairingStore = create<PairingState>((set, get) => ({
  pairing: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    let pairing: DevicePairing | null = null;
    try {
      const json = await AsyncStorage.getItem(STORAGE_KEY);
      if (json) pairing = normalizePairing(JSON.parse(json));
    } catch {}
    set({ pairing, loaded: true });
  },

  save: (pairing) => {
    set({ pairing });
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pairing)).catch(() => {});
  },

  clear: () => {
    set({ pairing: null });
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  },
}));