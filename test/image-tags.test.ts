import { describe, expect, it } from 'vitest';
// @ts-expect-error Release helper runs directly in Node, outside TypeScript build.
import { imageTags } from '../scripts/image-tags.mjs';
const sha = 'a'.repeat(40);
describe('container release policy', () => {
  it('publishes main commits by full SHA only', () => {
    expect(imageTags({ sha })).toEqual([`sha-${sha}`]);
  });
  it('publishes stable version and latest together', () => {
    expect(imageTags({ sha, version: '0.2.0', packageVersion: '0.2.0' })).toEqual([`sha-${sha}`, '0.2.0', 'latest']);
  });
  it('keeps prereleases and older release backfills off latest', () => {
    expect(imageTags({ sha, version: '0.3.0-rc.1', packageVersion: '0.3.0-rc.1' })).not.toContain('latest');
    expect(imageTags({ sha, version: '0.2.9', packageVersion: '0.2.9', stableVersions: ['0.10.0'] })).not.toContain('latest');
  });
  it('rejects mismatched versions and invalid tags', () => {
    expect(() => imageTags({ sha, version: '0.3.0', packageVersion: '0.2.0' })).toThrow();
    for (const version of ['01.2.0', '1.2.3+build', '1.2.3-01', 'latest', '1.2']) {
      expect(() => imageTags({ sha, version, packageVersion: version })).toThrow();
    }
    expect(() => imageTags({ sha: 'abc' })).toThrow();
  });
});
