/**
 * End-to-end classroom flows: a teacher and students in separate browser contexts,
 * talking to the real server over Socket.IO.
 */
import { expect, test, type Page } from '@playwright/test';
import { drawStroke, joinRoom, newUser, uniqueRoom } from './helpers';

const PIN = '4829';

/** The teacher's Class tab lists every student with their live item count. */
async function rosterRow(teacher: Page, name: string) {
  await teacher.getByRole('button', { name: /^Class/ }).click();
  return teacher.locator('div', { hasText: new RegExp(`^${name}\\s*Online`) }).first();
}

test.describe('lobby', () => {
  test('join is disabled until a name is entered, and the room code is kept in the URL', async ({ page }) => {
    const room = uniqueRoom('lobby');
    await page.goto(`/?room=${room}`);
    const join = page.getByRole('button', { name: 'Join Classroom' });
    await expect(join).toBeDisabled();
    await expect(page.getByText(`#${room}`)).toBeVisible();

    await page.getByLabel('Your Display Name').fill('   ');
    await expect(join).toBeDisabled();
    await page.getByLabel('Your Display Name').fill('Alex');
    await join.click();

    await expect(page.getByPlaceholder('Message the class...')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`room=${room}`));
    // Students do not get the teacher toolbar
    await expect(page.getByRole('button', { name: 'Lock Board' })).toHaveCount(0);
  });

  test('a returning user is rejoined automatically after a reload', async ({ page }) => {
    const room = uniqueRoom('reload');
    await joinRoom(page, room, 'Alex');
    await page.reload();
    await expect(page.getByPlaceholder('Message the class...')).toBeVisible();
    await expect(page.getByText('Alex', { exact: true }).first()).toBeVisible();
  });
});

test.describe('teacher and students', () => {
  test('chat messages reach the class and the teacher can delete them', async ({ browser }) => {
    const room = uniqueRoom('chat');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    const input = student.page.getByPlaceholder('Message the class...');
    await input.fill('Is the lab due Friday?');
    await input.press('Enter');

    await expect(teacher.page.getByText('Is the lab due Friday?')).toBeVisible();
    await expect(student.page.getByText('Is the lab due Friday?')).toBeVisible();

    await teacher.page.getByRole('button', { name: 'Delete message from Alex' }).click();
    await expect(student.page.getByText('Is the lab due Friday?')).toBeHidden();
    await expect(teacher.page.getByText('Is the lab due Friday?')).toBeHidden();

    await teacher.context.close();
    await student.context.close();
  });

  test('student ink syncs to the teacher, and undo removes it everywhere', async ({ browser }) => {
    const room = uniqueRoom('ink');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    await drawStroke(student.page);
    await expect(student.page.getByText('1 drawn')).toBeVisible();
    await expect(await rosterRow(teacher.page, 'Alex')).toContainText('1 item');

    await drawStroke(student.page, { x: 700, y: 700 }, { x: 1100, y: 650 });
    await expect(student.page.getByText('2 drawn')).toBeVisible();
    await expect(await rosterRow(teacher.page, 'Alex')).toContainText('2 items');

    await student.page.getByRole('button', { name: 'Undo' }).click();
    await expect(student.page.getByText('1 drawn')).toBeVisible();
    await expect(await rosterRow(teacher.page, 'Alex')).toContainText('1 item');

    await teacher.context.close();
    await student.context.close();
  });

  test('locking the board stops students drawing until it is unlocked', async ({ browser }) => {
    const room = uniqueRoom('lock');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    await teacher.page.getByRole('button', { name: 'Lock Board' }).click();
    await expect(teacher.page.getByRole('button', { name: 'Unlock Board' })).toBeVisible();

    await drawStroke(student.page);
    // Give the (rejected) stroke time to round-trip before asserting nothing landed
    await student.page.waitForTimeout(750);
    await expect(student.page.getByText('0 drawn')).toBeVisible();
    await expect(await rosterRow(teacher.page, 'Alex')).toContainText('0 items');

    await teacher.page.getByRole('button', { name: 'Unlock Board' }).click();
    await expect(teacher.page.getByRole('button', { name: 'Lock Board' })).toBeVisible();
    await drawStroke(student.page);
    await expect(student.page.getByText('1 drawn')).toBeVisible();

    await teacher.context.close();
    await student.context.close();
  });

  test('teacher Clear Ink wipes every student’s drawings', async ({ browser }) => {
    const room = uniqueRoom('clear');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    await drawStroke(student.page);
    await expect(student.page.getByText('1 drawn')).toBeVisible();

    await teacher.page.getByRole('button', { name: 'Clear Ink' }).click();
    // Inline two-step confirm: Cancel must leave the ink alone
    await teacher.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await student.page.waitForTimeout(500);
    await expect(student.page.getByText('1 drawn')).toBeVisible();

    await teacher.page.getByRole('button', { name: 'Clear Ink' }).click();
    await expect(teacher.page.getByText('Clear ink on')).toBeVisible();
    await teacher.page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(student.page.getByText('0 drawn')).toBeVisible();

    await teacher.context.close();
    await student.context.close();
  });

  test('a second person cannot become teacher with the wrong PIN', async ({ browser }) => {
    const room = uniqueRoom('pin');
    const teacher = await newUser(browser);
    const imposter = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);

    await imposter.page.goto(`/?room=${room}`);
    await imposter.page.getByLabel('Your Display Name').fill('Sneaky');
    await imposter.page.getByText('Instructor? Set or enter a room Teacher PIN').click();
    await imposter.page.locator('#teacher-pin-input').fill('0000');
    await imposter.page.getByRole('button', { name: 'Join Classroom' }).click();

    await expect(imposter.page.getByPlaceholder('Message the class...')).toBeVisible();
    await imposter.page.waitForTimeout(750);
    await expect(imposter.page.getByText('Teacher Active')).toHaveCount(0);
    await expect(imposter.page.getByRole('button', { name: 'Lock Board' })).toHaveCount(0);

    await teacher.context.close();
    await imposter.context.close();
  });
});
