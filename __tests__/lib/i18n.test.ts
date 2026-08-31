import { translate } from '../../lib/i18n';

describe('translate', () => {
  it('returns English and Chinese strings for the selected language', () => {
    expect(translate('en', 'mapping.button')).toBe('3D Mapping');
    expect(translate('zh', 'mapping.button')).toBe('3D 建图');
  });

  it('replaces named parameters', () => {
    expect(
      translate('zh', 'connect.detected', {
        transport: 'Foxglove',
        host: '192.168.1.2',
        port: 8765,
      }),
    ).toBe('192.168.1.2:8765 上的 Foxglove');
  });
});
