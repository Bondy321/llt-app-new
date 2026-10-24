import { describe, expect, it } from 'vitest';
import { adminBuildPolicy } from '../../buildConfig.js';
describe('deployable admin App Check build guard', () => {
  it('fails normal builds before generating output without a registered provider key', () => {
    for (const mode of ['production', 'development', 'preview']) {
      for (const key of [undefined, '', ' ', 'placeholder-site-key-for-production']) {
        expect(() => adminBuildPolicy({ command: 'build', mode, environment: { VITE_FIREBASE_APPCHECK_SITE_KEY: key } })).toThrow(/requires the registered/);
      }
    }
  });
  it('permits an explicitly configured site key but does not claim provider enrollment proof', () => {
    expect(adminBuildPolicy({ command: 'build', mode: 'production', environment: { VITE_FIREBASE_APPCHECK_SITE_KEY: '6LcTestShapeOnly_01234567890123456789012345' } })).toEqual({ outDir: 'dist' });
  });
  it('isolates a deliberately nondeployable compile verification and permits local dev', () => {
    expect(adminBuildPolicy({ command: 'build', mode: 'verification' })).toEqual({ outDir: 'verification-dist' });
    expect(adminBuildPolicy({ command: 'serve', mode: 'development' })).toEqual({ outDir: 'dist' });
  });
});
