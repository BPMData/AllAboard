import { expect, test } from '@playwright/test';
import { joinRoom, newUser, uniqueRoom } from './helpers';

/**
 * The real eraser: erasing across the middle of a shape-brush stroke leaves two pieces (no eraser stroke is
 * stored), the other screen sees the same, and one undo brings the whole stroke back.
 */
test('erasing a shape-brush stroke splits it, syncs, and undoes in one step', async ({ browser }) => {
  test.setTimeout(60_000);
  const room = uniqueRoom('eraser');
  const alex = await newUser(browser);
  const bea = await newUser(browser);
  await alex.page.addInitScript(() => localStorage.setItem('allaboard-hollow-shape', 'star'));
  await joinRoom(alex.page, room, 'Alex');
  await joinRoom(bea.page, room, 'Bea');

  const hollowButton = alex.page.getByTitle(/^Hollow Star Brush/);
  await hollowButton.click();
  await hollowButton.click();
  await expect(alex.page.getByRole('menu', { name: 'Hollow brush shapes' })).toHaveCount(0);

  await alex.page.mouse.move(500, 450);
  await alex.page.mouse.down();
  await alex.page.mouse.move(1000, 450, { steps: 25 });
  await alex.page.mouse.up();
  await expect(alex.page.getByText('1 drawn')).toBeVisible();

  await alex.page.getByTitle(/Personal Eraser/).click();
  await alex.page.mouse.move(750, 350);
  await alex.page.mouse.down();
  await alex.page.mouse.move(750, 550, { steps: 10 });
  await alex.page.mouse.up();

  // Two pieces, and no eraser stroke counted.
  await expect(alex.page.getByText('2 drawn')).toBeVisible();
  await expect(bea.page.getByText('2 drawn')).toBeVisible();

  await alex.page.getByRole('button', { name: 'Undo' }).click();
  await expect(alex.page.getByText('1 drawn')).toBeVisible();
  await expect(bea.page.getByText('1 drawn')).toBeVisible();

  // Erasing the whole stroke leaves nothing at all.
  await alex.page.mouse.move(450, 450);
  await alex.page.mouse.down();
  for (let y = 380; y <= 520; y += 20) {
    await alex.page.mouse.move(1050, y, { steps: 12 });
    await alex.page.mouse.move(450, y + 10, { steps: 12 });
  }
  await alex.page.mouse.up();
  // Nothing of the stroke, and no eraser stroke, is left.
  for (const u of [alex, bea]) {
    await expect(u.page.getByText(/^[12] drawn$/)).toHaveCount(0);
  }

  for (const u of [alex, bea]) await u.context.close();
});
