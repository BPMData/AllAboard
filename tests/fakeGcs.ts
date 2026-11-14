/**
 * In-memory fake of the Cloud Storage JSON API endpoints GcsBackend uses, as a fetch function.
 * Lets tests exercise GcsBackend's real URL building, auth header, paging and error handling.
 */
export interface FakeGcs {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  /** Make every request fail with this HTTP status (e.g. 403) until reset to 0. */
  failWith: number;
  requests: string[];
}

export function createFakeGcs(bucket: string, opts: { pageSize?: number; token?: string } = {}): FakeGcs {
  const pageSize = opts.pageSize ?? 1000;
  const token = opts.token ?? 'test-token';
  const fake: FakeGcs = {
    objects: new Map(),
    failWith: 0,
    requests: [],
    fetch: async (rawUrl, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      fake.requests.push(`${method} ${rawUrl}`);
      if (fake.failWith) return new Response('forced failure', { status: fake.failWith });
      const auth = new Headers(init.headers).get('Authorization');
      if (auth !== `Bearer ${token}`) return new Response('no auth', { status: 401 });

      const url = new URL(rawUrl);
      const b = encodeURIComponent(bucket);
      const objPrefix = `/storage/v1/b/${b}/o/`;
      if (method === 'POST' && url.pathname === `/upload/storage/v1/b/${b}/o`) {
        const name = url.searchParams.get('name')!;
        const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
        fake.objects.set(name, { bytes: body, contentType: new Headers(init.headers).get('Content-Type') ?? '' });
        return Response.json({ name });
      }
      if (url.pathname === `/storage/v1/b/${b}/o` && method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        const max = Number(url.searchParams.get('maxResults') ?? pageSize);
        const names = [...fake.objects.keys()].filter((n) => n.startsWith(prefix)).sort();
        const page = names.slice(start, start + Math.min(max, pageSize));
        const next = start + page.length < names.length ? String(start + page.length) : undefined;
        return Response.json({ items: page.map((name) => ({ name })), nextPageToken: next });
      }
      if (url.pathname.startsWith(objPrefix)) {
        const name = decodeURIComponent(url.pathname.slice(objPrefix.length));
        const obj = fake.objects.get(name);
        if (method === 'DELETE') {
          if (!obj) return new Response('', { status: 404 });
          fake.objects.delete(name);
          return new Response(null, { status: 204 });
        }
        if (!obj) return new Response('not found', { status: 404 });
        if (url.searchParams.get('alt') === 'media') return new Response(obj.bytes);
        return Response.json({ name });
      }
      return new Response('unexpected request', { status: 400 });
    },
  };
  return fake;
}
