import { expect, test, type Page } from '@playwright/test';
import { joinRoom, newUser, uniqueRoom } from './helpers';

const PIN = '4829';

/** A small PNG with a label, so the two variants are different images (different asset URLs). */
async function labeledPng(page: Page, label: string) {
  const b64 = await page.evaluate((text) => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#111827';
    ctx.font = '64px sans-serif';
    ctx.fillText(text, 40, 120);
    return c.toDataURL('image/png').split(',')[1];
  }, label);
  return { name: `card_${label}.png`, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

test('Send worksheet rotates A/B across individual boards', async ({ browser }) => {
  test.setTimeout(60_000);
  const room = uniqueRoom('sendws');
  const teacher = await newUser(browser);
  const alex = await newUser(browser);
  const bea = await newUser(browser);
  await joinRoom(teacher.page, room, 'Ms T', PIN);
  await joinRoom(alex.page, room, 'Alex');
  await joinRoom(bea.page, room, 'Bea');

  await teacher.page.getByTitle('Assign individual student boards or breakout group rooms').click();
  await teacher.page.getByRole('button', { name: 'Launch Round 1' }).click();
  await expect(teacher.page.getByText(/Live Classroom Boards Overview/)).toBeVisible();

  await teacher.page.getByRole('button', { name: 'Send worksheet…' }).click();
  const dialog = teacher.page.getByRole('dialog');
  await dialog.getByLabel('Worksheet A').setInputFiles(await labeledPng(teacher.page, 'A'));
  await expect(dialog.getByText(/card_A\.png · 1 page/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add variant' }).click();
  await dialog.getByLabel('Worksheet B').setInputFiles(await labeledPng(teacher.page, 'B'));
  await expect(dialog.getByText(/card_B\.png · 1 page/)).toBeVisible();

  // Two variants default to rotate: boards sorted by title, Alex → A, Bea → B.
  await expect(dialog.getByLabel(/Rotate/)).toBeChecked();
  await expect(dialog.getByLabel("Worksheet for Alex's Board")).toHaveValue('A');
  await expect(dialog.getByLabel("Worksheet for Bea's Board")).toHaveValue('B');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const alexImg = teacher.page.getByAltText("Alex's Board");
  const beaImg = teacher.page.getByAltText("Bea's Board");
  await expect(alexImg).toHaveAttribute('src', /^\/api\/assets\//);
  await expect(beaImg).toHaveAttribute('src', /^\/api\/assets\//);
  expect(await alexImg.getAttribute('src')).not.toEqual(await beaImg.getAttribute('src'));

  for (const u of [teacher, alex, bea]) await u.context.close();
});
