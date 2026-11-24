import { expect, test, type Page } from '@playwright/test';
import { joinRoom, uniqueRoom } from './helpers';

/** Counts requests to /api/report and answers them with `answer` (or lets them through to the real server). */
async function watchReports(page: Page, answer?: { status: number; body: unknown }) {
  const bodies: any[] = [];
  await page.route('**/api/report', async (route) => {
    bodies.push(route.request().postDataJSON());
    if (answer) await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
    else await route.continue();
  });
  return bodies;
}

const dialogOf = (page: Page) => page.getByRole('dialog');
const button = (page: Page, name: string) => dialogOf(page).getByRole('button', { name, exact: true });

async function walkToReview(page: Page, what: string) {
  const dialog = dialogOf(page);
  await expect(page.getByRole('dialog', { name: 'What went wrong?' })).toBeVisible();
  await expect(button(page, 'Next')).toBeDisabled();
  await dialog.getByRole('radio', { name: /^Chat/ }).check();
  await button(page, 'Next').click();

  await expect(dialog.getByRole('heading', { name: 'What happened?', exact: true })).toBeVisible();
  await dialog.getByLabel('What happened? (optional)').fill(what);
  await button(page, 'Next').click();

  await expect(dialog.getByRole('heading', { name: 'Anything else? (private)' })).toBeVisible();
  await dialog.getByLabel('How can we reach you? (optional)').fill('teacher@example.org');
  await dialog.getByLabel('Anything else? (optional)').fill('private note for the developer');
  await button(page, 'Review').click();
  await expect(dialog.getByRole('heading', { name: 'Check what will be sent' })).toBeVisible();
}

test('lobby: guided report shows public vs private, sends only on Send, and links the issue', async ({ page }) => {
  const room = uniqueRoom('report');
  const reports = await watchReports(page, {
    status: 200,
    body: { ok: true, issueUrl: 'https://github.com/BPMData/AllAboard/issues/123', issueNumber: 123, emailed: true },
  });
  await page.goto(`/?room=${room}`);
  await page.getByRole('button', { name: 'Something not working?', exact: true }).click();
  await walkToReview(page, `Chat froze in ${room}`);

  const publicPreview = page.getByTestId('report-public-preview');
  await expect(publicPreview).toContainText('What went wrong:** Chat');
  await expect(publicPreview).toContainText('Chat froze in [removed]');
  await expect(publicPreview).not.toContainText(room);
  await expect(publicPreview).not.toContainText('teacher@example.org');
  await expect(publicPreview).not.toContainText('private note');
  await expect(page.getByTestId('report-private-preview')).toContainText('teacher@example.org');
  expect(reports).toHaveLength(0);

  await button(page, 'Send report').click();
  await expect(dialogOf(page).getByRole('heading', { name: 'Thanks, your report was sent' })).toBeVisible();
  await expect(dialogOf(page).getByRole('link', { name: /See the public report \(#123\)/ })).toHaveAttribute(
    'href',
    'https://github.com/BPMData/AllAboard/issues/123',
  );
  expect(reports).toHaveLength(1);
  expect(JSON.stringify(reports[0])).not.toContain(room);
  expect(reports[0].diagnostics.page).toBe('lobby');

  await button(page, 'Done').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('in a room: when sending fails, offers copy, download and email to the shared inbox', async ({ page }) => {
  const room = uniqueRoom('report-fail');
  // No relay is configured on the test server, so the real route answers 503 not-configured.
  const reports = await watchReports(page);
  await joinRoom(page, room, 'Ms Report', '5173');
  await page.getByRole('button', { name: 'Something not working?', exact: true }).click();
  await walkToReview(page, 'Ms Report could not see messages');
  await expect(page.getByTestId('report-public-preview')).not.toContainText('Ms Report');
  await button(page, 'Send report').click();

  await expect(dialogOf(page).getByRole('heading', { name: 'The report wasn’t sent' })).toBeVisible();
  await expect(dialogOf(page).getByText(/overboard\.reporting@gmail\.com/)).toBeVisible();
  await expect(dialogOf(page).getByRole('link', { name: 'Open an email' })).toHaveAttribute('href', /^mailto:overboard\.reporting@gmail\.com\?subject=/);
  const download = page.waitForEvent('download');
  await button(page, 'Download report').click();
  expect((await download).suggestedFilename()).toMatch(/^allaboard-problem-report-.*\.txt$/);
  expect(reports).toHaveLength(1);
  expect(reports[0].diagnostics.role).toBe('teacher');
  expect(reports[0].diagnostics.connection).toBe('connected');
  expect(JSON.stringify(reports[0])).not.toContain(room);
  expect(JSON.stringify(reports[0])).not.toContain('5173');

  // Escape closes it and the class carries on: the board is still there.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.konvajs-content').first()).toBeVisible();
});
