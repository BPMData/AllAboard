/**
 * `POST /api/report`: the server side of "Something not working?" (issue #57, docs/REPORTS.md).
 *
 * The browser never sees a GitHub token. It posts the report here; this rebuilds the public issue and the private
 * email from the validated input (so a modified client can't add fields), and forwards both to the reporting relay:
 * OverBoard's Google Apps Script (`tools/report-relay.gs` in BPMData/OverBoard), which holds the GitHub token, opens
 * the issue in this repo and emails the shared inbox.
 *
 * Config, all optional (no relay → 503 'not-configured', and the browser offers Copy / Download / email instead):
 *   REPORT_RELAY_URL   the relay's /exec URL
 *   REPORT_RELAY_TOKEN shared secret the relay checks (its Script Property ALLABOARD_TOKEN)
 * Both are passed by deploy.yml from GitHub secrets of the same names.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  REPORT_APP_NAME,
  buildPrivateEmail,
  buildPublicIssue,
  normalizeReportInput,
  type RelayPayload,
  type ReportResponse,
} from './src/lib/problemReport.ts';

export const REPORT_BODY_LIMIT = '32kb';

/** JSON body parser that answers bad or oversized bodies with a JSON 400/413 instead of Express's HTML page. */
export function reportBodyParser() {
  const parse = express.json({ limit: REPORT_BODY_LIMIT });
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err?: any) => {
      if (err) {
        const status = err.type === 'entity.too.large' ? 413 : 400;
        send(res, status, { ok: false, error: 'invalid', message: 'The report could not be read.' });
        return;
      }
      next();
    });
  };
}
const PER_CLIENT_LIMIT = 10;
const PER_CLIENT_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_LIMIT = 60;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const RELAY_TIMEOUT_MS = 20_000;

export interface ReportRouteOptions {
  relayUrl?: string;
  relayToken?: string;
  /** Shown as "App version" (Cloud Run's K_REVISION in production). */
  appVersion?: string;
  /** Tests only. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Cloud Run appends the real client address last; earlier entries can be written by the client. */
function clientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded || '';
  const last = header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return last || req.socket.remoteAddress || 'unknown';
}

function makeLimiter(limit: number, windowMs: number, now: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((at) => t - at < windowMs)) hits.delete(k);
    }
    return true;
  };
}

function send(res: Response, status: number, body: ReportResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export function createReportHandler(options: ReportRouteOptions = {}) {
  const now = options.now ?? Date.now;
  const perClient = makeLimiter(PER_CLIENT_LIMIT, PER_CLIENT_WINDOW_MS, now);
  const global = makeLimiter(GLOBAL_LIMIT, GLOBAL_WINDOW_MS, now);
  const relayUrl = (options.relayUrl || '').trim();
  const relayToken = (options.relayToken || '').trim();
  const doFetch = options.fetchImpl ?? fetch;

  return async (req: Request, res: Response) => {
    const parsed = normalizeReportInput(req.body);
    if (parsed.ok === false) {
      send(res, 400, { ok: false, error: 'invalid', message: (parsed as { error: string }).error });
      return;
    }
    if (!relayUrl || !relayToken) {
      send(res, 503, { ok: false, error: 'not-configured', message: 'Automatic reporting is not set up yet.' });
      return;
    }
    if (!perClient(clientKey(req)) || !global('all')) {
      send(res, 429, { ok: false, error: 'rate-limited', message: 'Too many reports right now. Try again later.' });
      return;
    }

    const input = parsed.input;
    if (options.appVersion) input.diagnostics.appVersion = options.appVersion;
    const payload: RelayPayload & { token: string } = {
      token: relayToken,
      app: REPORT_APP_NAME,
      kind: 'problem-report',
      issue: buildPublicIssue(input),
      email: buildPrivateEmail(input),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
    try {
      // text/plain keeps Apps Script happy (it reads e.postData.contents either way).
      const relayRes = await doFetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await relayRes.text();
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (!relayRes.ok || !data || data.ok !== true) {
        console.error(`[report] relay failed: HTTP ${relayRes.status} ${String(data?.error || text).slice(0, 200)}`);
        send(res, 502, { ok: false, error: 'relay-failed', message: 'The report could not be sent.' });
        return;
      }
      // OverBoard's relay answers { ok, issue, url, emailed }; { issueNumber, issueUrl } is accepted too.
      const rawUrl = data.url ?? data.issueUrl;
      const rawNumber = data.issue ?? data.issueNumber;
      const issueUrl =
        typeof rawUrl === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(rawUrl)
          ? rawUrl
          : undefined;
      const issueNumber = Number.isInteger(rawNumber) ? rawNumber : undefined;
      console.log(
        `[report] sent: ${input.category}${issueUrl ? ` ${issueUrl}` : ''}${data.emailed ? ' (emailed)' : ''}`
      );
      send(res, 200, { ok: true, issueUrl, issueNumber, emailed: data.emailed === true });
    } catch (err) {
      console.error('[report] relay error:', err instanceof Error ? err.message : err);
      send(res, 502, { ok: false, error: 'relay-failed', message: 'The report could not be sent.' });
    } finally {
      clearTimeout(timer);
    }
  };
}
