import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rule 6 in CLAUDE.md: AllAboard never uses a sensitive or restricted Google OAuth scope.
 * Those trigger Google's manual review (restricted: also a paid security audit), a 100-user cap and an
 * "unverified app" screen, and school admins block them. Only these non-sensitive scopes are allowed.
 * Before adding anything here, check its category in Google's scope list and ask the owner.
 */
const ALLOWED_URL_SCOPES = new Set([
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]);
const ALLOWED_SHORT_SCOPES = new Set(['openid', 'email', 'profile']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|jsx|html)$/.test(name) ? [p] : [];
  });
}

describe('Google OAuth scopes', () => {
  it('only non-sensitive scopes appear in the app code', () => {
    const files = [...sourceFiles('src'), 'index.html', 'server.ts'];
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.\-]+/g)) {
        if (!ALLOWED_URL_SCOPES.has(m[0])) found.push(`${f}: ${m[0]}`);
      }
      // Short scope names inside a `scope: '...'` string, e.g. scope: 'openid email'.
      // (A quoted string followed by `|` is a TypeScript type like `scope: 'unified' | 'board'`, not a scope.)
      for (const m of text.matchAll(/\bscope\s*:\s*['"`]([^'"`]*)['"`](?!\s*\|)/g)) {
        for (const part of m[1].split(/\s+/).filter(Boolean)) {
          if (!part.startsWith('https://') && !ALLOWED_SHORT_SCOPES.has(part)) found.push(`${f}: scope "${part}"`);
        }
      }
    }
    assert.deepEqual(found, [], 'Sensitive or restricted Google scopes are not allowed. See rule 6 in CLAUDE.md.');
  });
});
