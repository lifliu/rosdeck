import { usePairingStore, normalizePairingHost } from '../../stores/usePairingStore';
import AsyncStorage from '@react-native-async-storage/async-storage';

beforeEach(() => {
  jest.restoreAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockReset().mockResolvedValue(null);
  (AsyncStorage.setItem as jest.Mock).mockReset().mockResolvedValue(undefined);
  (AsyncStorage.removeItem as jest.Mock).mockReset().mockResolvedValue(undefined);
  usePairingStore.setState({ pairing: null, loaded: false });
});

describe('normalizePairingHost', () => {
  it.each([
    ['192.168.1.50', '192.168.1.50'],
    ['192.168.1.50:8765', '192.168.1.50'],
    ['wss://192.168.1.50:8765', '192.168.1.50'],
    ['wss://robot.local:9443', 'robot.local'],
    ['  robot.local  ', 'robot.local'],
  ])('extracts the bare host from %s', (input, expected) => {
    expect(normalizePairingHost(input)).toBe(expected);
  });

  it.each([
    ['', 'empty input'],
    ['   ', 'whitespace only'],
    ['ws://192.168.1.50', 'cleartext ws scheme'],
    ['http://192.168.1.50', 'non-websocket scheme'],
    ['192.168.1.50:', 'trailing colon with no port'],
    ['300.0.0.1', 'invalid IP'],
  ])('rejects %s', (input, label) => {
    expect(normalizePairingHost(input)).toBeNull();
  });
});

describe('usePairingStore', () => {
  it('starts unpaired', () => {
    const state = usePairingStore.getState();
    expect(state.pairing).toBeNull();
    expect(state.loaded).toBe(false);
  });

  it('loads a saved pairing', async () => {
    const pairing = { host: '192.168.1.50', user: 'alice', token: 'omni_abc', pin: 'ab:cd' };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(pairing));

    await usePairingStore.getState().load();

    const state = usePairingStore.getState();
    expect(state.pairing).toEqual(pairing);
    expect(state.loaded).toBe(true);
  });

  it('treats corrupted storage as unpaired', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{not json');

    await usePairingStore.getState().load();

    expect(usePairingStore.getState().pairing).toBeNull();
    expect(usePairingStore.getState().loaded).toBe(true);
  });

  it('treats a partial pairing (missing token) as unpaired', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({
      host: '192.168.1.50', user: 'alice',
    }));

    await usePairingStore.getState().load();

    expect(usePairingStore.getState().pairing).toBeNull();
  });

  it('does not load twice', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify({
      host: '192.168.1.50', user: 'alice', token: 'omni_abc',
    }));

    await usePairingStore.getState().load();
    await usePairingStore.getState().load();

    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
  });

  it('save persists the pairing', async () => {
    const pairing = { host: '192.168.1.50', user: 'alice', token: 'omni_abc' };

    usePairingStore.getState().save(pairing);
    await Promise.resolve();

    expect(usePairingStore.getState().pairing).toEqual(pairing);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'omnideck_pairing',
      JSON.stringify(pairing),
    );
  });

  it('clear removes the pairing and the stored record', async () => {
    usePairingStore.getState().save({ host: '192.168.1.50', user: 'alice', token: 'omni_abc' });

    usePairingStore.getState().clear();
    await Promise.resolve();

    expect(usePairingStore.getState().pairing).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('omnideck_pairing');
  });
});