import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.ts';

type Handle = Awaited<ReturnType<typeof startServer>>;

const report = {
  category: 'sync',
  whatHappened: 'Ink vanished.',
  steps: '',
  keepDescriptionPrivate: false,
  contact: 'me@example.org',
  comments: 'private note',
  diagnostics: { browser: 'Chrome 131', roomId: 'should-not-pass' },
  roomCode: 'should-not-pass',
};

describe('POST /api/report', () => {
  const open: { srv: Handle; dir: string }[] = [];
  afterEach(async () => {
    for (const { srv, dir } of open.splice(0)) {
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function start(options: Parameters<typeof startServer>[0] = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-report-'));
    const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, skipVite: true, ...options });
    open.push({ srv, dir });
    return srv;
  }

  function post(srv: Handle, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${srv.port}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  function fakeRelay(answer: (payload: any) => { status?: number; body: unknown }) {
    const calls: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      const payload = JSON.parse(init.body);
      calls.push(payload);
      const { status = 200, body } = answer(payload);
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('answers not-configured (503) when no relay is set, so the browser offers the email fallback', async () => {
    const srv = await start({ reportRelayUrl: '', reportRelayToken: '' });
    const res = await post(srv, report);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'not-configured', message: 'Automatic reporting is not set up yet.' });
  });

  it('rejects a report without a valid category and unreadable bodies with JSON', async () => {
    const relay = fakeRelay(() => ({ body: { ok: true } }));
    const srv = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: relay.fetchImpl });
    const bad = await post(srv, { category: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid');
    const garbled = await post(srv, '{not json');
    assert.equal(garbled.status, 400);
    assert.equal((await garbled.json()).error, 'invalid');
    const huge = await post(srv, { category: 'sync', whatHappened: 'x'.repeat(40_000) });
    assert.equal(huge.status, 413);
    assert.equal(relay.calls.length, 0);
  });

  it('forwards a rebuilt public issue and private email to the relay and returns the issue link', async () => {
    const relay = fakeRelay(() => ({
      // the shape OverBoard's relay answers with
      body: { ok: true, issue: 99, url: 'https://github.com/BPMData/AllAboard/issues/99', emailed: true },
    }));
    const srv = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: relay.fetchImpl });
    const res = await post(srv, report);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      issueUrl: 'https://github.com/BPMData/AllAboard/issues/99',
      issueNumber: 99,
      emailed: true,
    });

    assert.equal(relay.calls.length, 1);
    const sent = relay.calls[0];
    assert.equal(sent.token, 'tok');
    assert.equal(sent.app, 'AllAboard');
    assert.equal(sent.kind, 'problem-report');
    const publicText = `${sent.issue.title}\n${sent.issue.body}`;
    assert.ok(publicText.includes('Ink vanished.'));
    assert.ok(publicText.includes('Chrome 131'));
    assert.ok(!publicText.includes('me@example.org'));
    assert.ok(!publicText.includes('private note'));
    assert.ok(!JSON.stringify(sent).includes('should-not-pass'));
    assert.ok(sent.email.body.includes('me@example.org'));
    assert.ok(sent.email.body.includes('private note'));
    assert.equal(sent.email.replyTo, 'me@example.org');
  });

  it('reports relay failures as 502 and never passes on an unexpected link', async () => {
    const failing = fakeRelay(() => ({ status: 500, body: 'boom' }));
    const srv = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: failing.fetchImpl });
    const res = await post(srv, report);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'relay-failed');

    const odd = fakeRelay(() => ({ body: { ok: true, url: 'https://evil.example/phish', emailed: true } }));
    const srv2 = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: odd.fetchImpl });
    const res2 = await post(srv2, report);
    assert.deepEqual(await res2.json(), { ok: true, emailed: true });

    const older = fakeRelay(() => ({ body: { ok: true, issueUrl: 'https://github.com/BPMData/AllAboard/issues/5', issueNumber: 5 } }));
    const srv3 = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: older.fetchImpl });
    assert.deepEqual(await (await post(srv3, report)).json(), {
      ok: true,
      issueUrl: 'https://github.com/BPMData/AllAboard/issues/5',
      issueNumber: 5,
      emailed: false,
    });
  });

  it('treats a thrown fetch (relay unreachable) as relay-failed', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const srv = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: fetchImpl });
    const res = await post(srv, report);
    assert.equal(res.status, 502);
  });

  it('rate-limits one client after 10 reports', async () => {
    const relay = fakeRelay(() => ({ body: { ok: true, emailed: true } }));
    const srv = await start({ reportRelayUrl: 'https://relay.test/exec', reportRelayToken: 'tok', reportFetch: relay.fetchImpl });
    for (let i = 0; i < 10; i++) assert.equal((await post(srv, report)).status, 200);
    const limited = await post(srv, report);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, 'rate-limited');
    // A different client (Cloud Run puts the real address last in X-Forwarded-For) still gets through.
    assert.equal((await post(srv, report, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.7' })).status, 200);
    assert.equal(relay.calls.length, 11);
  });
});
