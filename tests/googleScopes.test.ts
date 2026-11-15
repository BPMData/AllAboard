import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AllAboard only asks Google for drive.file (rule 6 in CLAUDE.md). Only the owner may add to ALLOWED.
 * Any other scope is "sensitive" or "restricted": manual review by Google, a 100-user cap and an
 * "unverified app" screen until it passes, and school admins may block the app.
 */
const ALLOWED = new Set(['https://www.googleapis.com/auth/drive.file']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|jsx|html)$/.test(name) ? [p] : [];
  });
}

describe('Google OAuth scopes', () => {
  it('only drive.file appears anywhere in the app code', () => {
    const files = [...sourceFiles('src'), 'index.html', 'server.ts'];
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.\-]+/g)) {
        if (!ALLOWED.has(m[0])) found.push(`${f}: ${m[0]}`);
      }
      // OpenID scopes ask for the user's identity and change the consent screen.
      if (/scope\s*:\s*['"`][^'"`]*\b(openid|email|profile)\b/.test(text)) found.push(`${f}: openid/email/profile scope`);
      if (/include_granted_scopes/.test(text)) found.push(`${f}: include_granted_scopes (incremental scopes)`);
    }
    assert.deepEqual(found, [], 'Only drive.file is allowed. See rule 6 in CLAUDE.md.');
  });
});
