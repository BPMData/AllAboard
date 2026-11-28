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

| Part                     | Public issue                        | Private email                                                  |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| Category                 | yes                                 | yes                                                            |
| Description and steps    | yes (scrubbed), unless kept private | yes                                                            |
| Contact, "anything else" | **never**                           | yes (contact also becomes Reply-To when it's an email address) |
| Diagnostics              | yes                                 | yes                                                            |

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
  → OverBoard's report relay (tools/report-relay.gs in BPMData/OverBoard, a Google Apps Script web app),
    posted as { app: 'AllAboard', kind: 'problem-report', token, issue, email }
      → GitHub: create the issue in this repo (token lives only in the script)
      → MailApp: email the private part to the inbox
```

One relay serves OverBoard, AllAboard, AllHail and OverHeard: same inbox, same GitHub key, same deployment. It turns
AllAboard posts away unless the token matches its `ALLABOARD_TOKEN` script property, and its limits (20 an hour, 40 a
day) are shared by all of those apps.

The server reads the relay's address and token from `REPORT_RELAY_URL` and `REPORT_RELAY_TOKEN`. In production
`deploy.yml` sets both on every deploy from Secret Manager (`--set-secrets`, secrets `allaboard-report-relay-url` and
`allaboard-report-relay-token` in `loyal-rookery-403218`). Only the service's runtime account, `allaboard-run`, can read
them. They are not GitHub secrets, and nothing is pasted into the Cloud Run console.

The browser never sees a GitHub token. `POST /api/report` answers `{ ok: true, issueUrl?, issueNumber?, emailed }`, or
`{ ok: false, error }` with `invalid` (400/413), `rate-limited` (429), `not-configured` (503) or `relay-failed` (502).
Every failure shows the copy/download/email fallback.

## Setup (one time, by the owner)

The relay address and token are already in Secret Manager and reach Cloud Run on every deploy. The relay itself only
accepts AllAboard reports once its `ALLABOARD_TOKEN` script property holds the same value as the
`allaboard-report-relay-token` secret, and its GitHub token can open issues here. Until then the app works and every
report uses the fallback (copy, download, email).

- **Label (optional):** in this repo, Issues ▸ Labels ▸ New label `user-report`. Without it issues are opened unlabeled.
- **Test it** after a deploy: send a report from the lobby. Check that an issue appears here, that the email arrives
  with `[AllAboard]` in the subject, and that the issue has no contact details.
- **Changing the token:** add a new version to `allaboard-report-relay-token`, put the same value in the relay's
  `ALLABOARD_TOKEN`, and redeploy (the deploy reads `:latest`).

The script's permission to send email and call GitHub belongs to the reports Google account, not to AllAboard's
Google sign-in, so it doesn't touch the OAuth scope rule in CLAUDE.md.

To turn reports off again, remove `ALLABOARD_TOKEN` from the relay's script properties.

## Emails to the reporter

- No thank-you email: the dialog shows "The developer has your report." once the relay has it. If the contact is an
  email address, the shared relay sends one "here's what we changed" email when the issue is **closed as completed**,
  and nothing else (an issue closed as not planned or as a duplicate sends nothing). Nobody answers reports by hand.

## Tests

`tests/problemReport.test.ts` (privacy, scrubbing, validation, fallback text), `tests/problemReportServer.test.ts`
(the route against a fake relay: success, not configured, failures, bad bodies, rate limit),
`e2e/problemReport.spec.ts` (the guided flow, nothing sent before Send, success link, failure fallback, Escape).
