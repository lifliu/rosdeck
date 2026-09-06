import fs from 'node:fs';
import path from 'node:path';
import { MAPPING_DISPOSITION } from '../../lib/autonomy-runtime';
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
});
