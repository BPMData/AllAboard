import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { drawStroke, joinRoom, newUser, uniqueRoom } from './helpers';

const PIN = '5173';

async function pngFile(page: Page, name: string) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#7c3aed';
    ctx.font = '40px sans-serif';
    ctx.fillText('Lesson worksheet', 20, 140);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

test('save a lesson as .allaboard, then load it into a new room with its prepared round', async ({ browser }) => {
  test.setTimeout(90_000);
  const room = uniqueRoom('lesson');
  const newRoom = uniqueRoom('lesson-copy');
  const teacher = await newUser(browser);
  const { page } = teacher;
  await joinRoom(page, room, 'Ms T', PIN);
  await drawStroke(page);

  // One prepared round with its own worksheet.
  await page.getByTitle('Assign individual student boards or breakout group rooms').click();
  await page.getByLabel('Round name (optional):').fill('Exit ticket');
  await page.getByLabel('Upload a worksheet file for this round').setInputFiles(await pngFile(page, 'exit_ticket.png'));
  await expect(page.getByText('Uploaded: exit_ticket.png')).toBeVisible();
  await page.getByRole('button', { name: 'Save for later' }).click();
  await expect(page.getByTestId('prepared-rounds').getByText('Round 1 · Individual · Exit ticket')).toBeVisible();
  await page.getByRole('button', { name: 'Close breakout manager' }).click();

  // Save lesson: the file carries the round, its worksheet image and the teacher's ink.
  await page.getByRole('button', { name: 'Save lesson…' }).click();
  const save = page.getByTestId('save-lesson-modal');
  await save.getByLabel('Lesson title').fill('Photosynthesis');
  await expect(save.getByTestId('lesson-size')).toContainText('photosynthesis-');
  await expect(save.getByText(/Teacher ink only \(1\)/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await save.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^photosynthesis-\d{4}-\d{2}-\d{2}\.allaboard$/);
  const filePath = await download.path();
  const pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(pack.kind).toBe('allaboard-lesson');
  expect(pack.rounds).toHaveLength(1);
  expect(Object.keys(pack.assets)).toHaveLength(1);
  expect(pack.main.elements).toHaveLength(1);
  await save.getByRole('button', { name: 'Close', exact: true }).click();

  // Load lesson into a new room.
  await page.getByRole('button', { name: 'Load lesson…' }).click();
  const load = page.getByTestId('load-lesson-modal');
  await load.getByLabel('Lesson file').setInputFiles(filePath);
  const preview = load.getByTestId('lesson-preview');
  await expect(preview.getByText('Photosynthesis')).toBeVisible();
  await expect(preview.getByText(/Exit ticket · Individual · exit_ticket\.png/)).toBeVisible();
  await load.getByLabel('Room code').fill(newRoom);
  await expect(load.getByLabel('Teacher PIN')).toHaveValue(PIN);
  await load.getByRole('button', { name: 'Load into new room' }).click();

  await expect(page).toHaveURL(new RegExp(`room=${newRoom}`));
  await expect(page.locator('button', { hasText: 'Clear Ink' })).toHaveCount(1); // teacher again, via the saved PIN
  await page.getByTitle('Assign individual student boards or breakout group rooms').click();
  const list = page.getByTestId('prepared-rounds');
  await expect(list.getByText('Round 1 · Individual · Exit ticket')).toBeVisible();
  await expect(list.getByText('Worksheet: exit_ticket.png')).toBeVisible();

  // A student who joins the loaded room stays on Main until the teacher launches the round.
  const alex = await newUser(browser);
  await joinRoom(alex.page, newRoom, 'Alex');
  await expect(alex.page.getByText(/Active Board:/)).toHaveCount(0);
  await list.getByRole('button', { name: 'Launch' }).click();
  await expect(alex.page.getByText("Active Board: Alex's Board")).toBeVisible();

  for (const u of [teacher, alex]) await u.context.close();
});
