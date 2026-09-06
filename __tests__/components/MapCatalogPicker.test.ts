import fs from 'node:fs';
import path from 'node:path';

describe('MapCatalogPicker authority boundary', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../components/MapCatalogPicker.tsx'),
    'utf8',
  );

  it('refreshes the typed robot catalog every time the modal opens', () => {
    expect(source).toContain('void refresh()');
    expect(source).toContain('listMaps(transport)');
    expect(source).toContain('关闭即作废请求并清除目录');
  });

  it('does not persist maps or call a private SLAM endpoint', () => {
    expect(source).not.toContain('AsyncStorage');
    expect(source).not.toContain('/omni/slam/maps/list');
    expect(source).not.toContain('/goal_pose');
  });

  it('selects one intact catalog entry rather than reconstructing identity fields', () => {
    expect(source).toContain('onSelect: (entry: MapCatalogEntry) => void');
    expect(source).toContain('onPress={() => selected && onSelect(selected)}');
    expect(source).toContain('mapIdentityKey(entry)');
  });

  it('keeps its list and actions reachable on short landscape screens', () => {
    expect(source).toContain("catalogArea: { minHeight: 80");
    expect(source).toContain("flexShrink: 1");
    expect(source).toContain("maxHeight: '94%'");
  });
});
