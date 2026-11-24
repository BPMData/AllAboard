import { expect, test } from '@playwright/test';
import { drawStroke, joinRoom, newUser, uniqueRoom } from './helpers';

const PIN = '5173';

test('a round can copy the teacher’s Main ink onto every board', async ({ browser }) => {
  test.setTimeout(60_000);
  const room = uniqueRoom('tmplink');
  const teacher = await newUser(browser);
  const alex = await newUser(browser);
  await joinRoom(teacher.page, room, 'Ms T', PIN);
  await joinRoom(alex.page, room, 'Alex');
  await drawStroke(teacher.page);

  await teacher.page.getByTitle('Assign individual student boards or breakout group rooms').click();
  await teacher.page.getByLabel('Round name (optional):').fill('Annotate');
  const copyInk = teacher.page.getByLabel(/Also copy my ink from Main \(1 mark\)/);
  await copyInk.check();
  await teacher.page.getByRole('button', { name: 'Save for later' }).click();

  const list = teacher.page.getByTestId('prepared-rounds');
  await expect(list.getByText('+ your ink (1 mark)')).toBeVisible();
  await list.getByRole('button', { name: 'Launch' }).click();
  await expect(alex.page.getByText("Active Board: Alex's Board")).toBeVisible();

  for (const u of [teacher, alex]) await u.context.close();
});
