import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Production Node type-stripping boot check', () => {
  it('loads server.ts and its entire import graph under plain Node without tsx', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', "import('./server.ts').then(() => console.log('OK'))"],
      {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '' },
      }
    );
    assert.equal(stdout.trim(), 'OK');
  });
});
