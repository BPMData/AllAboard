# Problem reports ("Something not working?")

Issue #57. Anyone can report a bug from the app without a GitHub account. Each report becomes a labeled public
issue in this repo and a private email to the shared reporting inbox, **overboard.reporting@gmail.com** (the same inbox
OverBoard uses; subjects start with `[AllAboard]` so the two apps are easy to tell apart).

## Where people find it

- **Lobby:** "Something not working?" button, bottom right.
- **In a room:** "Something not working?" in the chat sidebar's room bar, or the life-buoy button next to the room
  chip when the chat sidebar is hidden.

The dialog is local to the browser until the reporter presses **Send report**: it emits nothing on the socket and
changes no room state, so class carries on.

## The flow

1. **What went wrong?** Joining/connection, drawing/sync, worksheets, breakouts/student boards, chat, teacher tools,
   saving/loading, something else.
2. **What happened?** and **How can we make it happen again?** Both optional. A "keep this description private"
   box moves them to the email only.
3. **Anything else? (private)** Optional contact and comments. Email only, never in the issue.
4. **Review.** Shows the exact public issue (title and body) and the private part. Nothing is sent before this step.
5. **Result.** A link to the issue when there is one. If sending fails, is not set up, or the browser is offline:
   **Copy report**, **Download report** (.txt) and **Open an email** (mailto: the inbox), with the inbox address shown.

## What's in a report

| Part | Public issue | Private email |
|---|---|---|
| Category | yes | yes |
| Description and steps | yes (scrubbed), unless kept private | yes |
| Contact, "anything else" | **never** | yes (contact also becomes Reply-To when it's an email address) |
| Diagnostics | yes | yes |

**Diagnostics** (`ReportDiagnostics` in `src/lib/problemReport.ts`, whitelisted on the server): app version (Cloud
Run's `K_REVISION`, added by the server), browser and OS (major version only), screen size, language, touch, online,
lobby or room, socket connected/disconnected and transport, teacher or student, breakout mode, kind of board being
viewed (main/individual/group, never its id), worksheet page count, number of items on the board, people in the room,
canvas locked, chat hidden.

**Never sent:** names, room codes, PINs, chat, drawings, worksheets. The browser removes the room code, the saved PIN
and every roster name from the description before the preview, and those values never leave the browser. Then
emails, links, phone numbers and numbers of four or more digits (except years) are removed too. The server rebuilds the
issue and email from the validated fields, so a modified client can't add anything.

## How it's wired

```
Browser  POST /api/report (JSON, 32 KB max)
  → server.ts / problemReportRoute.ts: validate, rebuild issue + email, rate-limit
      (10 per client per 10 min, 60 per hour overall)
  → relay (tools/report-relay.gs, Google Apps Script web app), with a shared token
      → GitHub: create the issue (token lives only in the script)
      → MailApp: email the private part to the inbox
```

The browser never sees a GitHub token. `POST /api/report` answers `{ ok: true, issueUrl?, issueNumber?, emailed }`, or
`{ ok: false, error }` with `invalid` (400/413), `rate-limited` (429), `not-configured` (503) or `relay-failed` (502).
Every failure shows the copy/download/email fallback.

## Setup (one time, by the owner)

Until this is done, the app works and every report uses the fallback (copy, download, email).

1. **GitHub token.** Create a fine-grained personal access token: repository access *only* `BPMData/AllAboard`,
   permission **Issues: Read and write**, nothing else. Optionally create a `user-report` label (the relay retries
   without labels if it can't use it).
2. **Apps Script.** Signed in as the account that should send the emails (ideally overboard.reporting@gmail.com),
   create a new project at script.google.com and paste in `tools/report-relay.gs`.
   - Project Settings → Script properties: `RELAY_TOKEN` (a long random string, e.g. `openssl rand -hex 32`),
     `GITHUB_TOKEN` (step 1). Optional: `GITHUB_REPO` (default `BPMData/AllAboard`), `REPORT_INBOX`
     (default overboard.reporting@gmail.com).
   - Deploy → New deployment → **Web app**, Execute as **Me**, Who has access **Anyone**. Authorize it (it asks to
     send email and connect to external services; this is the script's own permission on that account, not
     AllAboard's Google sign-in, so it doesn't touch the OAuth scope rule in CLAUDE.md). Copy the `/exec` URL.
   - Opening the `/exec` URL in a browser should show `{"ok":true,"service":"report-relay"}`.
3. **GitHub secrets** on this repo (Settings → Secrets and variables → Actions): `REPORT_RELAY_URL` (the `/exec`
   URL) and `REPORT_RELAY_TOKEN` (the same value as `RELAY_TOKEN`). `deploy.yml` passes both to Cloud Run as env vars
   on the next deploy. Without them it leaves the flag out and deploys exactly as before.
4. **Test it** after the deploy: send a report from the lobby. Check that an issue appears with the `user-report`
   label, that the email arrives with `[AllAboard]` in the subject, and that the issue has no contact details.

If OverBoard's relay already runs under the inbox account, a second deployment of this script (its own project and
token) is the simplest; the two never share a GitHub token.

To turn reports off again, delete the two secrets and redeploy, or remove `REPORT_RELAY_URL` from the service.

## Not built

- No acknowledgement email to the reporter and no follow-up when a fix ships. The dialog doesn't promise either.
  Reply-To on the private email lets the developer answer by hand.

## Tests

`tests/problemReport.test.ts` (privacy, scrubbing, validation, fallback text), `tests/problemReportServer.test.ts`
(the route against a fake relay: success, not configured, failures, bad bodies, rate limit),
`e2e/problemReport.spec.ts` (the guided flow, nothing sent before Send, success link, failure fallback, Escape).
