import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore, internBackground, assetUrl } from '../roomStore.ts';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function bg(dataUrl: string) {
  return { id: 'bg1', fileName: 'w.pdf', pages: [{ dataUrl, width: 1, height: 1 }], x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1 };
}

describe('RoomStore', () => {
  let dir: string;
  let store: RoomStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomstore-'));
    store = new RoomStore(path.join(dir, 'allaboard.db'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes identical worksheet pages into one asset', () => {
    const a = internBackground(store, bg(PNG_1PX));
    const b = internBackground(store, bg(PNG_1PX));
    assert.match(a.pages[0].dataUrl, /^\/api\/assets\/[a-f0-9]{64}$/);
    assert.equal(a.pages[0].dataUrl, b.pages[0].dataUrl);
    assert.equal(store.countAssets(), 1);
    const hash = a.pages[0].dataUrl.split('/').pop()!;
    const asset = store.getAsset(hash)!;
    assert.equal(asset.mime, 'image/png');
    assert.ok(asset.bytes.length > 0);
  });

  it('leaves already-interned and null backgrounds alone', () => {
    const a = internBackground(store, bg(PNG_1PX));
    assert.deepEqual(internBackground(store, a), a);
    assert.equal(internBackground(store, null), null);
  });

  it('round-trips a room and isolates rooms', () => {
    store.saveRoom('a', { id: 'a', elements: [1] }, 100);
    store.saveRoom('b', { id: 'b', elements: [2] }, 200);
    assert.deepEqual(store.loadRoom('a'), { state: { id: 'a', elements: [1] }, lastActiveAt: 100 });
    store.saveRoom('a', { id: 'a', elements: [1, 3] }, 150);
    assert.deepEqual(store.loadRoom('b')!.state, { id: 'b', elements: [2] });
    assert.equal(store.loadRoom('missing'), null);
  });

  it('garbage-collects assets no room references', () => {
    const page = internBackground(store, bg(PNG_1PX));
    store.saveRoom('a', { id: 'a', background: page }, Date.now());
    assert.equal(store.gcAssets(0), 0); // still referenced
    store.saveRoom('a', { id: 'a', background: null }, Date.now());
    assert.equal(store.gcAssets(60_000), 0); // inside grace period
    assert.equal(store.gcAssets(-1), 1);
    assert.equal(store.countAssets(), 0);
  });

  it('cascade-deletes asset refs with expired rooms', () => {
    const page = internBackground(store, bg(PNG_1PX));
    store.saveRoom('old', { id: 'old', background: page }, 10);
    store.saveRoom('new', { id: 'new' }, Date.now());
    assert.deepEqual(store.deleteRoomsInactiveBefore(1000), ['old']);
    assert.equal(store.loadRoom('old'), null);
    assert.equal(store.gcAssets(-1), 1);
  });

  it('assetUrl is the expected shape', () => {
    assert.equal(assetUrl('a'.repeat(64)), '/api/assets/' + 'a'.repeat(64));
  });
});
