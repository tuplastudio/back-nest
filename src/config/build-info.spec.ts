import { readBuildInfo } from './build-info';

describe('readBuildInfo', () => {
  it('reads the version and SHA stamped into the image', () => {
    expect(readBuildInfo({ BUILD_VERSION: '1.4.2', BUILD_SHA: ' 0123abc ' })).toEqual({
      version: '1.4.2',
      sha: '0123abc',
    });
  });

  it('falls back when the image was not stamped, so a local run still boots', () => {
    expect(readBuildInfo({ BUILD_SHA: '' })).toEqual({ version: '1.0.0', sha: 'unknown' });
  });
});
