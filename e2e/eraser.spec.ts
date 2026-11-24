import { expect, test, type Page } from '@playwright/test';
import { joinRoom, newUser, uniqueRoom } from './helpers';

const PIN = '4829';

/** "N drawn" is only the viewer's own count, so the other screen is checked on the teacher's Class tab. */
async function rosterRow(teacher: Page, name: string) {
  await teacher.getByRole('button', { name: /^Class/ }).click();
  return teacher.locator('div', { hasText: new RegExp(`^${name}\\s*Online`) }).first();
}

/**
 * The real eraser: erasing across the middle of a shape-brush stroke leaves two pieces (no eraser stroke is
 * stored), the other screen sees the same, and one undo brings the whole stroke back.
 */
test('erasing a shape-brush stroke splits it, syncs, and undoes in one step', async ({ browser }) => {
  test.setTimeout(60_000);
  const room = uniqueRoom('eraser');
  const teacher = await newUser(browser);
  const alex = await newUser(browser);
  await alex.page.addInitScript(() => localStorage.setItem('allaboard-hollow-shape', 'star'));
  await joinRoom(teacher.page, room, 'Ms T', PIN);
  await joinRoom(alex.page, room, 'Alex');

  const hollowButton = alex.page.getByTitle(/^Hollow Star Brush/);
  await hollowButton.click();
  await hollowButton.click();
  await expect(alex.page.getByRole('menu', { name: 'Hollow brush shapes' })).toHaveCount(0);

  await alex.page.mouse.move(500, 450);
  await alex.page.mouse.down();
  await alex.page.mouse.move(1000, 450, { steps: 25 });
  await alex.page.mouse.up();
  await expect(alex.page.getByText('1 drawn')).toBeVisible();
  await expect(await rosterRow(teacher.page, 'Alex')).toContainText('1 item');

  await alex.page.getByTitle(/Personal Eraser/).click();
  await alex.page.mouse.move(750, 350);
  await alex.page.mouse.down();
  await alex.page.mouse.move(750, 550, { steps: 10 });
  await alex.page.mouse.up();

  // Two pieces, and no eraser stroke counted.
  await expect(alex.page.getByText('2 drawn')).toBeVisible();
  await expect(await rosterRow(teacher.page, 'Alex')).toContainText('2 items');

  await alex.page.getByRole('button', { name: 'Undo' }).click();
  await expect(alex.page.getByText('1 drawn')).toBeVisible();
  await expect(await rosterRow(teacher.page, 'Alex')).toContainText('1 item');

  // Erasing the whole stroke leaves nothing at all.
  await alex.page.mouse.move(450, 450);
  await alex.page.mouse.down();
  for (let y = 380; y <= 520; y += 20) {
    await alex.page.mouse.move(1050, y, { steps: 12 });
    await alex.page.mouse.move(450, y + 10, { steps: 12 });
  }
  await alex.page.mouse.up();
  // Nothing of the stroke, and no eraser stroke, is left.
  await expect(alex.page.getByText('0 drawn')).toBeVisible();
  await expect(await rosterRow(teacher.page, 'Alex')).toContainText('0 items');

  for (const u of [teacher, alex]) await u.context.close();
});
