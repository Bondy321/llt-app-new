/** Verification bundles are deliberately separate from deployable hosting output. */
export function adminBuildPolicy({ command, mode, environment = {} }) {
  if (command !== 'build') return { outDir: 'dist' };
  if (mode === 'verification') return { outDir: 'verification-dist' };
  const key = environment.VITE_FIREBASE_APPCHECK_SITE_KEY?.trim();
  if (!key || !/^[A-Za-z0-9_-]{20,}$/.test(key) || /placeholder|synthetic|example|changeme/i.test(key)) {
    throw new Error('Production admin build requires the registered VITE_FIREBASE_APPCHECK_SITE_KEY. Configure the real reCAPTCHA Enterprise App Check provider before building deployable output. CI compile-only checks may use --mode verification (verification-dist).');
  }
  return { outDir: 'dist' };
}
