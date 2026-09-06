import fs from 'node:fs';
import path from 'node:path';

describe('Mission screen asset lifecycle', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../app/(tabs)/mission.tsx'),
    'utf8',
  );

  it('refreshes the authoritative route catalog whenever the tab regains focus', () => {
    expect(source).toContain('useFocusEffect(');
    expect(source).toContain('void refreshRoutes();');
    expect(source).toContain('onAction={() => void refreshRoutes(true)}');
    expect(source).toContain('beginRoutesRefresh()');
    expect(source).toContain('listRoutes(transport)');
  });

  it('uses the shared end-to-end inspection command lifetime', () => {
    expect(source).toContain('DEFAULT_INSPECTION_COMMAND_TTL_SEC');
    expect(source).not.toContain("createMissionRequestEnvelope('inspection', 30)");
  });

  it('rechecks active mission state at the final dispatch boundary', () => {
    expect(source).toContain(
      'ACTIVE_MISSION_STATES.includes(store.status.state)',
    );
    expect(source).toContain("store.setError(t('mission.activeBlocksDispatch'))");
  });
});
