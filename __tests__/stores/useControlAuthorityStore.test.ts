import { CONTROL_CLIENT_ID } from '../../lib/control-authority';
import {
  mobileControlBlocksCommands,
  useControlAuthorityStore,
} from '../../stores/useControlAuthorityStore';

describe('useControlAuthorityStore', () => {
  beforeEach(() => useControlAuthorityStore.getState().reset('detecting'));

  it('blocks commands until this app owns the lease', () => {
    expect(mobileControlBlocksCommands()).toBe(true);
    useControlAuthorityStore.getState().applyStatus({ state: 'available' });
    expect(mobileControlBlocksCommands()).toBe(true);
    useControlAuthorityStore.getState().applyStatus({
      state: 'acquired', ownerId: CONTROL_CLIENT_ID,
    });
    expect(mobileControlBlocksCommands()).toBe(false);
  });

  it('does not treat another app ownership as local control', () => {
    useControlAuthorityStore.getState().applyStatus({
      state: 'acquired', ownerId: 'app-other',
    });
    expect(useControlAuthorityStore.getState().status).toBe('owned_by_other');
    expect(mobileControlBlocksCommands()).toBe(true);
  });

  it('keeps legacy bridges unblocked', () => {
    useControlAuthorityStore.getState().applyStatus({ state: 'unsupported' });
    expect(mobileControlBlocksCommands()).toBe(false);
  });
});
