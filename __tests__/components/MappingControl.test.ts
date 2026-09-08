import fs from 'node:fs';
import path from 'node:path';
import { MAPPING_DISPOSITION, isValidMapId } from '../../lib/autonomy-runtime';
import { translate } from '../../lib/i18n';

describe('MappingControl runtime migration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../components/MappingControl.tsx'),
    'utf8',
  );

  it('does not publish the retired Bridge process-control topics', () => {
    expect(source).not.toContain('/rosdeck/');
    expect(source).toContain('setAutonomyMode');
    expect(source).toContain('finishMapping');
  });

  it('offers explicit save and discard dispositions', () => {
    expect(MAPPING_DISPOSITION.SAVE).toBe(1);
    expect(MAPPING_DISPOSITION.DISCARD).toBe(2);
    expect(translate('zh', 'mapping.stopConfirmMessage')).toContain('保存');
    expect(translate('zh', 'mapping.stopConfirmMessage')).toContain('丢弃');
    expect(source).toContain('MAPPING_DISPOSITION.SAVE');
    expect(source).toContain('MAPPING_DISPOSITION.DISCARD');
  });

  it('keeps the future map id local until FinishMapping SAVE', () => {
    expect(source).toContain('setMappingTargetId(normalizedMapId)');
    const startCall = source.match(
      /setAutonomyMode\(transport,\s*\{[\s\S]*?\n\s*\}\);/,
    )?.[0] ?? '';
    expect(startCall).not.toMatch(/\n\s*mapId(?:\s*:|\s*,)/);
    expect(source).toContain('mapId: disposition === MAPPING_DISPOSITION.SAVE');
    expect(source).not.toContain('mappingTargetId || runtime?.map_id');
  });

  it('requires the operator to confirm a valid custom map name before starting', () => {
    expect(source).toContain('<TextInput');
    expect(source).toContain("t('mapping.mapName')");
    expect(source).toContain('isValidMapId(normalizedMapId)');
    expect(source).toContain('setSetupOpen(true)');
    expect(source).toContain('setMapId(mappingTargetId || generateMappingMapId())');
    expect(source).toContain('绝不能误用 SLAM 的 external_map_id');
    expect(isValidMapId('factory_a-floor-1')).toBe(true);
    expect(isValidMapId('工厂一层')).toBe(false);
  });
});
