import { expect, test, type Page } from '@playwright/test';
import { joinRoom, newUser, uniqueRoom } from './helpers';

const PIN = '5173';

async function pngFile(page: Page, name: string) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#111827';
    ctx.font = '48px sans-serif';
    ctx.fillText('Exit ticket', 40, 120);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}

test('a prepared individual round moves nobody until the teacher launches it', async ({ browser }) => {
  test.setTimeout(60_000);
  const room = uniqueRoom('prepared');
  const teacher = await newUser(browser);
  const alex = await newUser(browser);
  await joinRoom(teacher.page, room, 'Ms T', PIN);
  await joinRoom(alex.page, room, 'Alex');

  await teacher.page.getByTitle('Assign individual student boards or breakout group rooms').click();
  await teacher.page.getByLabel('Round name (optional):').fill('Exit ticket');
  await teacher.page
    .getByLabel('Upload a worksheet file for this round')
    .setInputFiles(await pngFile(teacher.page, 'exit_ticket.png'));
  await expect(teacher.page.getByText('Uploaded: exit_ticket.png')).toBeVisible();
  await teacher.page.getByRole('button', { name: 'Save for later' }).click();

  const list = teacher.page.getByTestId('prepared-rounds');
  await expect(list.getByText('Round 1 · Individual · Exit ticket')).toBeVisible();
  await expect(list.getByText('Worksheet: exit_ticket.png')).toBeVisible();
  // Alex is still on Main: the student banner only shows during a breakout.
  await expect(alex.page.getByText(/Active Board:/)).toHaveCount(0);

  await list.getByRole('button', { name: 'Launch' }).click();
  await expect(teacher.page.getByText(/Live Classroom Boards Overview/)).toBeVisible();
  await expect(alex.page.getByText("Active Board: Alex's Board")).toBeVisible();
  await expect(teacher.page.getByAltText("Alex's Board")).toHaveAttribute('src', /^\/api\/assets\//);

  for (const u of [teacher, alex]) await u.context.close();
});

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

test('a prepared round deals out worksheets A and B when it launches', async ({ browser }) => {
  test.setTimeout(60_000);
  const room = uniqueRoom('prepvar');
  const teacher = await newUser(browser);
  const alex = await newUser(browser);
  const bea = await newUser(browser);
  await joinRoom(teacher.page, room, 'Ms T', PIN);
  await joinRoom(alex.page, room, 'Alex');
  await joinRoom(bea.page, room, 'Bea');

  await teacher.page.getByTitle('Assign individual student boards or breakout group rooms').click();
  await teacher.page.getByLabel('Round name (optional):').fill('Cards');
  await teacher.page.getByLabel('Upload a worksheet file for this round').setInputFiles(await labeledPng(teacher.page, 'A'));
  await expect(teacher.page.getByText('Uploaded: card_A.png')).toBeVisible();

  const editor = teacher.page.getByTestId('variants-editor');
  await editor.getByRole('button', { name: 'Add worksheet B' }).click();
  await editor.getByLabel('Worksheet B', { exact: true }).setInputFiles(await labeledPng(teacher.page, 'B'));
  await expect(editor.getByText(/card_B\.png · 1 page/)).toBeVisible();
  await editor.getByLabel(/Deal out A, B in turn/).check();
  await teacher.page.getByRole('button', { name: 'Save for later' }).click();

  const list = teacher.page.getByTestId('prepared-rounds');
  await expect(list.getByText(/\+ worksheet B \(dealt out in turn\)/)).toBeVisible();
  await expect(alex.page.getByText(/Active Board:/)).toHaveCount(0);

  await list.getByRole('button', { name: 'Launch' }).click();
  await expect(teacher.page.getByText(/Live Classroom Boards Overview/)).toBeVisible();
  const alexImg = teacher.page.getByAltText("Alex's Board");
  const beaImg = teacher.page.getByAltText("Bea's Board");
  await expect(alexImg).toHaveAttribute('src', /^\/api\/assets\//);
  await expect(beaImg).toHaveAttribute('src', /^\/api\/assets\//);
  expect(await alexImg.getAttribute('src')).not.toEqual(await beaImg.getAttribute('src'));

  // Send worksheet… starts from what the round handed out.
  await teacher.page.getByRole('button', { name: 'Send worksheet…' }).click();
  const dialog = teacher.page.getByRole('dialog');
  await expect(dialog.getByText(/card_B\.png · 1 page/)).toBeVisible();
  await expect(dialog.getByLabel("Worksheet for Alex's Board")).toHaveValue('A');
  await expect(dialog.getByLabel("Worksheet for Bea's Board")).toHaveValue('B');

  for (const u of [teacher, alex, bea]) await u.context.close();
});
