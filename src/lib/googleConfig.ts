// Public, non-secret values from Phase 0. Hardcoded on purpose: AI Studio Publish rewrites env vars (CLAUDE.md rule 1).
const DEFAULTS = {
  clientId: '', // OAuth 2.0 Web client ID
  apiKey: '',   // Browser API key restricted to the Picker API
  appId: '',    // Google Cloud project NUMBER
};

export interface GoogleConfig {
  clientId: string;
  apiKey: string;
  appId: string;
}

export function getGoogleConfig(): GoogleConfig {
  // Test hook (Playwright). All values are public, so this is harmless in production.
  const override = typeof window !== 'undefined' ? (window as any).__ALLABOARD_GOOGLE_CONFIG__ : undefined;
  return { ...DEFAULTS, ...(override || {}) };
}

export function isGoogleSignInConfigured(): boolean {
  return Boolean(getGoogleConfig().clientId);
}

export function isGoogleDriveConfigured(): boolean {
  const c = getGoogleConfig();
  return Boolean(c.clientId && c.apiKey && c.appId);
}
