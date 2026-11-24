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
