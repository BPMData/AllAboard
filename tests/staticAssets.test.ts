import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import express from 'express';
import { distRouter } from '../staticAssets.ts';

function get(port: number, urlPath: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

describe('distRouter (production static files)', () => {
  let dir: string;
  let server: http.Server;
  let port: number;
  const js = 'console.log("hello");\n'.repeat(500);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), js);
    fs.writeFileSync(path.join(dir, 'assets', 'pdf.worker-abc.mjs'), js);
    fs.writeFileSync(path.join(dir, 'assets', 'logo-abc.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'outside.js'), 'outside');
    const app = express();
    app.use(distRouter(dir));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = (server.address() as any).port;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gzips hashed JS once and caches it for a year', async () => {
    const res = await get(port, '/assets/index-abc.js', { 'accept-encoding': 'gzip, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.equal(zlib.gunzipSync(res.body).toString(), js);
    assert.ok(res.body.length < js.length / 5);
  });

  it('serves .mjs (pdf.js worker) with a JavaScript MIME type', async () => {
    const res = await get(port, '/assets/pdf.worker-abc.mjs', { 'accept-encoding': 'gzip' });
    assert.match(String(res.headers['content-type']), /text\/javascript/);
  });

  it('falls back to plain files without gzip support, still immutable', async () => {
    const res = await get(port, '/assets/index-abc.js');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.toString(), js);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    const png = await get(port, '/assets/logo-abc.png', { 'accept-encoding': 'gzip' });
    assert.equal(png.headers['content-encoding'], undefined);
  });

  it('never caches index.html, including the SPA fallback', async () => {
    for (const p of ['/', '/index.html', '/some/room']) {
      const res = await get(port, p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['cache-control'], 'no-cache', p);
      assert.match(res.body.toString(), /<title>x<\/title>/);
    }
  });

  it('the gzip/immutable handler never reaches outside dist/assets', async () => {
    const res = await get(port, '/assets/..%2Foutside.js', { 'accept-encoding': 'gzip' });
    assert.notEqual(res.headers['content-encoding'], 'gzip');
    assert.notEqual(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });
});
