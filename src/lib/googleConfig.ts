// Public, non-secret values from Phase 0. Hardcoded on purpose: AI Studio Publish rewrites env vars (CLAUDE.md rule 1).
const DEFAULTS = {
  clientId: '606573080592-qtfiemip0l022q25monfj5hbhl6kamap.apps.googleusercontent.com', // OAuth 2.0 Web client ID
  apiKey: 'AIzaSyDj4vCWgF3I8dQm7yh1u2ExeZOVjHwpGCo', // Browser API key restricted to the Picker API
  appId: '606573080592', // Google Cloud project NUMBER
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
