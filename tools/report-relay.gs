/**
 * AllAboard problem-report relay (Google Apps Script web app). Setup: docs/REPORTS.md.
 *
 * The AllAboard server (problemReportRoute.ts) POSTs { token, app, issue: {title, body, labels}, email: {subject,
 * body, replyTo?} }. This script:
 *   1. checks the shared token,
 *   2. creates the public GitHub issue with a token only this script can see,
 *   3. emails the private part (contact details, private comments) to the reporting inbox,
 * and answers { ok, issueUrl?, issueNumber?, emailed }. ok is true when either the issue or the email went through,
 * so a GitHub outage still delivers the email.
 *
 * Script Properties (Project Settings > Script properties):
 *   RELAY_TOKEN   required. Long random string; the same value as the REPORT_RELAY_TOKEN GitHub secret.
 *   GITHUB_TOKEN  required for issues. Fine-grained token, only BPMData/AllAboard, "Issues: Read and write".
 *   GITHUB_REPO   optional, default "BPMData/AllAboard".
 *   REPORT_INBOX  optional, default "overboard.reporting@gmail.com" (shared with OverBoard).
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. Use the /exec URL.
 */

var DEFAULT_REPO = 'BPMData/AllAboard';
var DEFAULT_INBOX = 'overboard.reporting@gmail.com';
var MAX_TITLE = 200;
var MAX_BODY = 20000;
var MAX_PER_HOUR = 60;

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return reply_({ ok: false, error: 'bad-json' });
  }

  var expected = props.getProperty('RELAY_TOKEN');
  if (!expected || !data || typeof data.token !== 'string' || !safeEqual_(data.token, expected)) {
    return reply_({ ok: false, error: 'unauthorized' });
  }
  if (!data.issue || !data.email || typeof data.issue.title !== 'string' || typeof data.email.subject !== 'string') {
    return reply_({ ok: false, error: 'bad-request' });
  }
  if (!underHourlyLimit_()) {
    return reply_({ ok: false, error: 'rate-limited' });
  }

  var app = String(data.app || 'AllAboard').slice(0, 40);
  var result = { ok: false, emailed: false };

  var githubToken = props.getProperty('GITHUB_TOKEN');
  if (githubToken) {
    try {
      var issue = createIssue_(props.getProperty('GITHUB_REPO') || DEFAULT_REPO, githubToken, data.issue);
      result.issueUrl = issue.html_url;
      result.issueNumber = issue.number;
    } catch (err) {
      console.error('GitHub issue failed: ' + err);
    }
  }

  try {
    var subject = String(data.email.subject).slice(0, MAX_TITLE);
    if (subject.indexOf('[' + app + ']') !== 0) subject = '[' + app + '] ' + subject;
    if (result.issueNumber) subject += ' (issue #' + result.issueNumber + ')';
    var body = String(data.email.body || '').slice(0, MAX_BODY);
    body += '\n\n' + (result.issueUrl ? 'Public issue: ' + result.issueUrl : 'No public issue was created.');
    var options = { name: app + ' reports' };
    var replyTo = String(data.email.replyTo || '');
    if (/^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(replyTo)) options.replyTo = replyTo;
    MailApp.sendEmail(props.getProperty('REPORT_INBOX') || DEFAULT_INBOX, subject, body, options);
    result.emailed = true;
  } catch (err) {
    console.error('Email failed: ' + err);
  }

  result.ok = Boolean(result.issueUrl) || result.emailed;
  if (!result.ok) result.error = 'delivery-failed';
  return reply_(result);
}

/** Opening the /exec URL in a browser shows this, which is a quick "is it deployed?" check. */
function doGet() {
  return reply_({ ok: true, service: 'report-relay' });
}

function createIssue_(repo, token, issue) {
  var payload = {
    title: String(issue.title).slice(0, MAX_TITLE),
    body: String(issue.body || '').slice(0, MAX_BODY),
    labels: Array.isArray(issue.labels) ? issue.labels.slice(0, 5).map(String) : [],
  };
  var res = githubPost_(repo, token, payload);
  // A label that doesn't exist yet can be refused; try once more without labels.
  if (res.getResponseCode() === 422 && payload.labels.length) {
    payload.labels = [];
    res = githubPost_(repo, token, payload);
  }
  if (res.getResponseCode() !== 201) {
    throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

function githubPost_(repo, token, payload) {
  return UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/issues', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function underHourlyLimit_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache();
    var key = 'reports-' + Math.floor(Date.now() / 3600000);
    var count = Number(cache.get(key) || '0');
    if (count >= MAX_PER_HOUR) return false;
    cache.put(key, String(count + 1), 3700);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
