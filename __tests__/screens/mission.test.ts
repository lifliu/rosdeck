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

  it('offers checkpoint editing from the selected route and refreshes its checksum', () => {
    expect(source).toContain('<RouteCheckpointEditor');
    expect(source).toContain("language === 'zh' ? '编辑检查点'");
    expect(source).toContain('await refreshRoutes(true);');
    expect(source).toContain('selectRoute(routeId)');
  });

  it('queries durable checkpoint results instead of relying on the live topic', () => {
    expect(source).toContain('getCheckpointResults(transport, missionId)');
    expect(source).toContain('任务进入终态时从 SQLite 权威查询结果');
    expect(source).toContain('任务身份切换时立即丢弃上一任务的证据');
    expect(source).toContain('checkpointResultsRequestSerial.current += 1');
    expect(source).toContain("停留动作不产生证据记录");
  });
});
