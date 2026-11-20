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

  test('a browser reusing someone else’s user id is turned away, then joins as itself after a refresh', async ({ browser }) => {
    const room = uniqueRoom('identity');
    const owner = await newUser(browser);
    await joinRoom(owner.page, room, 'Sam');
    const ownerId = await owner.page.evaluate(() => localStorage.getItem('drawchat_user_id'));

    const impostor = await newUser(browser);
    await impostor.page.goto(`/?room=${room}`);
    await impostor.page.evaluate((id) => localStorage.setItem('drawchat_user_id', id as string), ownerId);
    await impostor.page.reload();
    await impostor.page.getByLabel('Your Display Name').fill('Sam');
    await impostor.page.getByRole('button', { name: 'Join Classroom' }).click();
    await expect(impostor.page.getByText(/couldn't be verified/)).toBeVisible();

    await impostor.page.reload();
    await impostor.page.getByLabel('Your Display Name').fill('Ada');
    await impostor.page.getByRole('button', { name: 'Join Classroom' }).click();
    await expect(impostor.page.getByPlaceholder('Message the class...')).toBeVisible();
    const newId = await impostor.page.evaluate(() => localStorage.getItem('drawchat_user_id'));
    expect(newId).not.toBe(ownerId);

    await owner.context.close();
    await impostor.context.close();
  });

  test('room history records visited rooms, shows live/saved status, and lets users select or clear them', async ({ browser }) => {
    const roomA = uniqueRoom('hist-a');
    const roomB = uniqueRoom('hist-b');
    const user = await newUser(browser);
    const other = await newUser(browser);

    // Another user stays in roomA so it remains live even after the main user moves to roomB
    await joinRoom(other.page, roomA, 'Sam');

    // Main user visits roomA, then moves to roomB
    await joinRoom(user.page, roomA, 'Ms T', PIN);
    await joinRoom(user.page, roomB, 'Ms T', PIN);

    // Open History in the Chat sidebar: both rooms should appear as Live · 1 online
    await user.page.getByRole('button', { name: 'History' }).click();
    const chatMenu = user.page.getByRole('region', { name: 'Recent room history' });
    await expect(chatMenu).toBeVisible();
    await expect(chatMenu.getByText(roomB)).toBeVisible();
    await expect(chatMenu.getByText(roomA)).toBeVisible();
    await expect(chatMenu.getByRole('button', { name: new RegExp(`^${roomA}.*Live · 1 online`) })).toBeVisible();

    // Once the other user leaves roomA, refreshing status shows roomA as Saved · rejoinable
    await other.context.close();
    await user.page.waitForTimeout(100);
    await chatMenu.getByRole('button', { name: 'Refresh room status' }).click();
    await expect(chatMenu.getByRole('button', { name: new RegExp(`^${roomA}.*Saved · rejoinable`) })).toBeVisible();

    // Return to Lobby (fresh visit), open History, and select roomA to fill the Room Code input
    await user.page.goto('/');
    await expect(user.page.getByRole('button', { name: 'Join Classroom' })).toBeVisible();
    await user.page.getByRole('button', { name: 'History' }).click();
    const lobbyMenu = user.page.getByRole('region', { name: 'Recent room history' });
    await expect(lobbyMenu.getByText(roomA)).toBeVisible();
    await lobbyMenu.getByRole('button', { name: new RegExp(`^${roomA}`) }).click();
    await expect(user.page.getByLabel('Room Code')).toHaveValue(roomA);

    // Clear history empties the list
    await user.page.getByRole('button', { name: 'History' }).click();
    await user.page.getByRole('region', { name: 'Recent room history' }).getByRole('button', { name: 'Clear' }).click();
    await expect(user.page.getByRole('region', { name: 'Recent room history' }).getByText('No rooms visited on this browser yet.')).toBeVisible();

    await user.context.close();
  });
});

test.describe('teacher and students', () => {
  test('teacher shares an anonymized breakout board to Main', async ({ browser }) => {
    const room = uniqueRoom('share');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');
    await teacher.page.getByTitle('Assign individual student boards or breakout group rooms').click();
    await teacher.page.getByRole('button', { name: 'Launch Round 1' }).click();
    await expect(teacher.page.getByText(/Live Classroom Boards Overview/)).toBeVisible();
    await student.page.getByRole('button', { name: 'Need Help', exact: true }).click();
    await expect(teacher.page.getByRole('button', { name: "Clear Alex's status" })).toBeVisible();
    await drawStroke(student.page);
    await expect(student.page.getByText('1 drawn')).toBeVisible();
    await student.page.getByTitle(/Quick Stamp Tool/).click();
    await student.page.getByTitle('Stamp Your Username Badge').click();
    await student.page.mouse.click(800, 500);
    await expect(student.page.getByText('2 drawn')).toBeVisible();
    await teacher.page.getByRole('button', { name: 'Share to Main', exact: true }).click();
    const dialog = teacher.page.getByRole('dialog');
    await expect(dialog.getByLabel('Anonymize authors and remove name stamps')).toBeChecked();
    await expect(dialog.getByLabel('Bring class to Main')).toBeChecked();
    await dialog.getByRole('button', { name: 'Share to Main' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(student.page.getByText('0 drawn')).toBeVisible();
    await expect(teacher.page.getByRole('button', { name: 'Bring All to Main' })).toHaveCount(0);
    await teacher.page.getByRole('button', { name: /^Class/ }).click();
    await expect(teacher.page.getByText('Alex', { exact: true }).first()).toBeVisible();
    // Listed in the "Ink by" picker, but not as a person in the Class list
    await expect(teacher.page.getByLabel('Focus ink by student').locator('option', { hasText: 'Class Example' })).toHaveCount(1);
    await expect(teacher.page.locator(':not(option):text-is("Class Example")')).toHaveCount(0);
    await teacher.context.close();
    await student.context.close();
  });

  test('selecting ink shows teachers who made it, and never shows students', async ({ browser }) => {
    // Two-browser test with slow lasso drags; the default 30s is too tight on CI runners.
    test.setTimeout(60_000);
    const room = uniqueRoom('authors');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    const lassoBoard = async (page: Page) => {
      const corners = [[1300, 230], [1300, 840], [600, 840], [600, 230]];
      await page.keyboard.press('v');
      await page.mouse.move(600, 230);
      await page.mouse.down();
      for (const [x, y] of corners) await page.mouse.move(x, y, { steps: 8 });
      await page.mouse.up();
    };

    // A drawing, a highlight and a text note from the same student
    await drawStroke(student.page, { x: 720, y: 340 }, { x: 980, y: 360 });
    await student.page.keyboard.press('m');
    await drawStroke(student.page, { x: 720, y: 470 }, { x: 980, y: 490 });
    await student.page.keyboard.press('t');
    await student.page.mouse.click(760, 600);
    const note = student.page.getByLabel('Editable text note');
    await note.fill('Hello');
    await note.press('Escape');
    await expect(student.page.getByText('3 drawn')).toBeVisible();

    await lassoBoard(student.page);
    await expect(student.page.getByText('3 selected')).toBeVisible();
    await expect(student.page.getByTestId('selection-authors')).toHaveCount(0);

    await expect.poll(async () => {
      await lassoBoard(teacher.page);
      return teacher.page.getByText('3 selected').count();
      // One lasso drag alone takes ~5s on GitHub's runners, so the default 5s poll timed out
      // before it ever checked. Leave room for a few tries.
    }, { timeout: 20_000 }).toBe(1);
    const authors = teacher.page.getByTestId('selection-authors');
    await expect(authors).toHaveText('By Alex');
    await expect(authors).toHaveAttribute('title', 'Alex (3 items)');

    // A single click on one stroke works too
    await teacher.page.mouse.click(1250, 260);
    await expect(authors).toHaveCount(0);
    await teacher.page.keyboard.press('p');
    await drawStroke(teacher.page, { x: 720, y: 780 }, { x: 980, y: 780 });
    await teacher.page.keyboard.press('v');
    await teacher.page.mouse.click(850, 780);
    await expect(authors).toHaveText('By You');

    await teacher.context.close();
    await student.context.close();
  });

  test('a teacher can focus on one student’s ink without changing the board', async ({ browser }) => {
    const room = uniqueRoom('inkfocus');
    const teacher = await newUser(browser);
    const alex = await newUser(browser);
    const priya = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(alex.page, room, 'Alex');
    await joinRoom(priya.page, room, 'Priya');
    await drawStroke(alex.page, { x: 720, y: 400 }, { x: 980, y: 420 });
    await drawStroke(priya.page, { x: 720, y: 560 }, { x: 980, y: 580 });

    const fadedLayers = (page: Page) =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('.konvajs-content canvas')).filter((c) => getComputedStyle(c).opacity === '0.12').length
      );
    const focus = teacher.page.getByLabel('Focus ink by student');
    await expect(focus.locator('option')).toHaveText(['Everyone', 'Alex (1)', 'Priya (1)']);

    await focus.selectOption({ label: 'Alex (1)' });
    await expect.poll(() => fadedLayers(teacher.page)).toBe(1);
    expect(await fadedLayers(alex.page)).toBe(0);
    await expect(alex.page.getByLabel('Focus ink by student')).toHaveCount(0);

    await focus.selectOption({ label: 'Everyone' });
    await expect.poll(() => fadedLayers(teacher.page)).toBe(0);

    await teacher.context.close();
    await alex.context.close();
    await priya.context.close();
  });

  test('one name stamp rule: the option returns when the student removes their stamp', async ({ browser }) => {
    const room = uniqueRoom('onestamp');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');
    await teacher.page.getByRole('button', { name: 'One Name Stamp: Off' }).click();
    await expect(teacher.page.getByRole('button', { name: 'One Name Stamp: On' })).toBeVisible();

    await student.page.getByTitle(/Quick Stamp Tool/).click();
    await student.page.getByTitle('Stamp Your Username Badge').click();
    await student.page.mouse.click(800, 500);
    await expect(student.page.getByText('1 drawn')).toBeVisible();
    const taken = student.page.getByTitle(/already placed your name stamp/);
    await expect(taken).toBeDisabled();

    // Clicking the board again does not add a second stamp
    await student.page.mouse.click(950, 650);
    await student.page.waitForTimeout(200);
    await expect(student.page.getByText('1 drawn')).toBeVisible();

    await student.page.getByRole('button', { name: 'Undo' }).click();
    await expect(student.page.getByText('0 drawn')).toBeVisible();
    await student.page.getByTitle(/Quick Stamp Tool/).click();
    await expect(student.page.getByTitle('Stamp Your Username Badge')).toBeEnabled();

    await teacher.context.close();
    await student.context.close();
  });

  test('student status cycles and the teacher can clear it', async ({ browser }) => {
    const room = uniqueRoom('status');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');
    await teacher.page.getByRole('button', { name: /^Class/ }).click();
    for (const label of ['Need Help', 'Got It', 'Done']) {
      await student.page.getByRole('button', { name: label, exact: true }).click();
      await expect(student.page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(teacher.page.getByRole('button', { name: "Clear Alex's status" }).locator('..')).toContainText(label);
    }
    await teacher.page.getByRole('button', { name: "Clear Alex's status" }).click();
    await expect(student.page.getByRole('button', { name: 'Done', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await student.page.getByRole('button', { name: 'Need Help', exact: true }).click();
    await teacher.page.getByRole('button', { name: 'Clear all statuses' }).click();
    await expect(student.page.getByRole('button', { name: 'Need Help', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await teacher.context.close();
    await student.context.close();
  });

  test('teacher laser gestures do not create ink', async ({ browser }) => {
    const room = uniqueRoom('laser');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');
    await expect(student.page.getByRole('button', { name: 'Laser pointer' })).toHaveCount(0);
    await teacher.page.getByRole('button', { name: 'Laser pointer' }).click();
    await drawStroke(teacher.page);
    // Canvas positions differ when the teacher toolbar wraps, so compare world-relative coordinates.
    const teacherCanvas = await teacher.page.locator('.konvajs-content canvas').first().boundingBox();
    if (!teacherCanvas) throw new Error('Teacher canvas is missing');
    await teacher.page.mouse.move(450, 250);
    const hasLaser = () => student.page.evaluate(({ offsetX, offsetY }) => Array.from(document.querySelectorAll('.konvajs-content canvas')).some((canvas) => {
      const el = canvas as HTMLCanvasElement;
      const ctx = el.getContext('2d');
      const bounds = el.getBoundingClientRect();
      if (!ctx || !el.width || !el.height) return false;
      const x = Math.round(offsetX * el.width / bounds.width);
      const y = Math.round(offsetY * el.height / bounds.height);
      if (x < 4 || y < 4 || x + 4 >= el.width || y + 4 >= el.height) return false;
      const pixels = ctx.getImageData(x - 4, y - 4, 8, 8).data;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 200 && pixels[i + 1] < 100 && pixels[i + 2] < 100 && pixels[i + 3] > 30) return true;
      }
      return false;
    }), { offsetX: 1000 - teacherCanvas.x, offsetY: 600 - teacherCanvas.y });
    await expect.poll(hasLaser, { timeout: 1000 }).toBe(true);
    await expect.poll(hasLaser, { timeout: 3000 }).toBe(false);
    await expect(teacher.page.getByText('0 drawn')).toBeVisible();
    await expect(student.page.getByText('0 drawn')).toBeVisible();
    await teacher.context.close();
    await student.context.close();
  });

  test('the teacher can hide and restore student cursors', async ({ browser }) => {
    const room = uniqueRoom('cursors');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');
    await expect(student.page.getByRole('button', { name: 'Hide Student Cursors' })).toHaveCount(0);
    await teacher.page.getByRole('button', { name: 'Hide Student Cursors' }).click();
    await expect(teacher.page.getByRole('button', { name: 'Show Student Cursors' })).toHaveAttribute('aria-pressed', 'true');
    await teacher.page.reload();
    await expect(teacher.page.getByRole('button', { name: 'Show Student Cursors' })).toBeVisible();
    await teacher.page.getByRole('button', { name: 'Show Student Cursors' }).click();
    await expect(teacher.page.getByRole('button', { name: 'Hide Student Cursors' })).toBeVisible();
    await teacher.context.close();
    await student.context.close();
  });

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

  test('batched ink arrives point-for-point: the teacher’s copy of a stroke matches the student’s', async ({ browser }) => {
    const room = uniqueRoom('inkexact');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    // A long, slow stroke spans many 50 ms send batches.
    await student.page.mouse.move(600, 350);
    await student.page.mouse.down();
    for (let i = 1; i <= 40; i++) {
      await student.page.mouse.move(600 + i * 12, 350 + Math.round(Math.sin(i / 4) * 80));
      await student.page.waitForTimeout(8);
    }
    await student.page.mouse.up();
    await expect(await rosterRow(teacher.page, 'Alex')).toContainText('1 item');
    await teacher.page.waitForTimeout(300); // last batch + one frame

    const strokeOf = async (page: Page) => {
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Save .JSON' }).click();
      const file = await (await download).path();
      const snapshot = JSON.parse((await import('node:fs')).readFileSync(file!, 'utf8'));
      return snapshot.elements[0].points as number[];
    };
    const mine = await strokeOf(student.page);
    const theirs = await strokeOf(teacher.page);
    expect(mine.length).toBeGreaterThan(40);
    expect(theirs).toEqual(mine);

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

  test('teacher PIN inputs use masked text fields without password autofill and support show/hide', async ({ page }) => {
    const room = uniqueRoom('pinmask');
    await page.goto(`/?room=${room}`);
    await page.getByLabel('Your Display Name').fill('Ms T');
    await page.getByText('Instructor? Set or enter a room Teacher PIN').click();

    const lobbyPin = page.locator('#teacher-pin-input');
    await expect(lobbyPin).toHaveAttribute('type', 'text');
    await expect(lobbyPin).toHaveAttribute('autocomplete', 'off');
    await expect(lobbyPin).toHaveClass(/pin-masked/);

    await page.getByRole('button', { name: 'Show Teacher PIN' }).click();
    await expect(lobbyPin).not.toHaveClass(/pin-masked/);
    await page.getByRole('button', { name: 'Hide Teacher PIN' }).click();
    await expect(lobbyPin).toHaveClass(/pin-masked/);

    // Join without claiming teacher, then claim teacher via the in-room drawer
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Join Classroom' }).click();
    await expect(page.getByPlaceholder('Message the class...')).toBeVisible();

    await page.getByRole('button', { name: 'Claim Teacher' }).click();
    const drawerPin = page.getByLabel('Room Teacher PIN');
    await expect(drawerPin).toHaveAttribute('type', 'text');
    await expect(drawerPin).toHaveAttribute('autocomplete', 'off');
    await expect(drawerPin).toHaveClass(/pin-masked/);

    await page.getByRole('button', { name: 'Show PIN' }).click();
    await expect(drawerPin).not.toHaveClass(/pin-masked/);
    await drawerPin.fill(PIN);
    await page.getByRole('button', { name: 'Set PIN' }).click();
    await expect(page.getByText('Teacher Active')).toBeVisible();
  });
});

test.describe('chat sidebar', () => {
  test('can be resized by dragging, reset on double-click, and persists across reload', async ({ page }) => {
    const room = uniqueRoom('resize');
    await joinRoom(page, room, 'Alex');

    const sidebar = page.getByLabel('Class chat sidebar');
    const handle = page.getByRole('separator', { name: 'Resize chat sidebar' });
    const stage = page.locator('.konvajs-content canvas').first();

    const initialSidebarBox = await sidebar.boundingBox();
    const initialStageBox = await stage.boundingBox();
    expect(initialSidebarBox?.width).toBe(320);

    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 140, startY, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(460);
    await expect.poll(async () => Math.round((await stage.boundingBox())!.width)).toBe(
      Math.round(initialStageBox!.width - 140)
    );

    // Persists after reload
    await page.reload();
    await expect(page.getByPlaceholder('Message the class...')).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(460);

    // Double-click resets back to 320px
    const reloadedHandleBox = await handle.boundingBox();
    await page.mouse.dblclick(
      reloadedHandleBox!.x + reloadedHandleBox!.width / 2,
      reloadedHandleBox!.y + reloadedHandleBox!.height / 2
    );
    await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(320);
  });

  test('can be hidden with one click to focus on drawing and restored with unread count', async ({ browser }) => {
    const room = uniqueRoom('hidechat');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Alex');

    const sidebar = student.page.getByLabel('Class chat sidebar');
    const stage = student.page.locator('.konvajs-content canvas').first();
    const beforeStageWidth = (await stage.boundingBox())!.width;

    // Hide chat sidebar
    await student.page.getByRole('button', { name: 'Hide chat sidebar' }).click();
    await expect(sidebar).toHaveCount(0);

    const showChatBtn = student.page.getByRole('button', { name: 'Show chat sidebar' });
    await expect(showChatBtn).toBeVisible();
    await expect.poll(async () => Math.round((await stage.boundingBox())!.width)).toBe(
      Math.round(beforeStageWidth + 320)
    );

    // Student can draw cleanly on the expanded canvas (including where the sidebar used to be)
    await drawStroke(student.page, { x: 120, y: 350 }, { x: 350, y: 500 });

    // Teacher sends a message while student's chat is hidden
    const teacherInput = teacher.page.getByPlaceholder('Message the class...');
    await teacherInput.fill('Nice work!');
    await teacherInput.press('Enter');

    await expect(showChatBtn).toContainText('1');

    // Restore chat with one click and confirm unread badge clears and message is visible
    await showChatBtn.click();
    await expect(sidebar).toBeVisible();
    await expect(student.page.getByText('Nice work!')).toBeVisible();
    await expect(student.page.getByText('1 drawn')).toBeVisible();

    await teacher.context.close();
    await student.context.close();
  });
});

test.describe('room exists confirmation modal', () => {
  test('warns when switching to an active room from chat sidebar and lets user cancel, join anyway, or create a fresh room', async ({ browser }) => {
    const occupiedRoom = uniqueRoom('occupied');
    const teacherRoom = uniqueRoom('myclass');
    const otherTeacher = await newUser(browser);
    const secondTeacher = await newUser(browser);

    // First teacher claims occupiedRoom with a PIN and draws something
    await joinRoom(otherTeacher.page, occupiedRoom, 'Ms. First', PIN);
    await drawStroke(otherTeacher.page);

    // Second teacher starts in their own unclaimed room
    await joinRoom(secondTeacher.page, teacherRoom, 'Mr. Second');

    // Second teacher tries switching to occupiedRoom via chat room switcher -> sees confirmation modal
    await secondTeacher.page.getByTitle('Click to enter a different room code').click();
    const roomInput = secondTeacher.page.getByPlaceholder('room-code');
    await roomInput.fill(occupiedRoom);
    await roomInput.press('Enter');

    const dialog = secondTeacher.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Room Already Exists')).toBeVisible();
    await expect(dialog.getByText(`#${occupiedRoom}`)).toBeVisible();
    await expect(dialog.getByText('1 person currently online')).toBeVisible();
    await expect(dialog.getByText('Teacher PIN already set')).toBeVisible();

    // Cancel keeps second teacher in their original room
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(secondTeacher.page).toHaveURL(new RegExp(`room=${teacherRoom}`));

    // Re-try switching to occupiedRoom and click "Create Fresh Room" -> moves to a new unclaimed room
    await secondTeacher.page.getByTitle('Click to enter a different room code').click();
    await secondTeacher.page.getByPlaceholder('room-code').fill(occupiedRoom);
    await secondTeacher.page.getByPlaceholder('room-code').press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Create Fresh Room' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(secondTeacher.page).toHaveURL(/room=class-/);

    // Re-try switching to occupiedRoom and click "Join Anyway" -> enters occupiedRoom
    await secondTeacher.page.getByTitle('Click to enter a different room code').click();
    await secondTeacher.page.getByPlaceholder('room-code').fill(occupiedRoom);
    await secondTeacher.page.getByPlaceholder('room-code').press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Join Anyway' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(secondTeacher.page).toHaveURL(new RegExp(`room=${occupiedRoom}`));
    await secondTeacher.page.getByRole('button', { name: /^Class/ }).click();
    await expect(secondTeacher.page.getByText('Ms. First').first()).toBeVisible();

    await otherTeacher.context.close();
    await secondTeacher.context.close();
  });

  test('warns in lobby only when user edits room code to an existing room, not on direct invite links', async ({ browser }) => {
    const existingRoom = uniqueRoom('lp');
    const host = await newUser(browser);
    const visitor = await newUser(browser);
    const invitee = await newUser(browser);

    await joinRoom(host.page, existingRoom, 'Ms. Host', PIN);

    // Invitee opens invite link directly -> joins with zero modal
    await invitee.page.goto(`/?room=${existingRoom}`);
    await invitee.page.getByLabel('Your Display Name').fill('Sam');
    await invitee.page.getByRole('button', { name: 'Join Classroom' }).click();
    await expect(invitee.page.getByRole('dialog')).toHaveCount(0);
    await expect(invitee.page.getByPlaceholder('Message the class...')).toBeVisible();

    // Visitor lands at `/` and manually types the existing room code -> sees confirmation modal
    await visitor.page.goto('/');
    await visitor.page.getByLabel('Your Display Name').fill('Mr. Visitor');
    await visitor.page.getByLabel('Room Code').fill(existingRoom);
    await visitor.page.getByRole('button', { name: 'Join Classroom' }).click();

    const dialog = visitor.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Room Already Exists')).toBeVisible();

    await dialog.getByRole('button', { name: 'Create Fresh Room' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(visitor.page.getByPlaceholder('Message the class...')).toBeVisible();
    await expect(visitor.page).toHaveURL(/room=class-/);

    await host.context.close();
    await visitor.context.close();
    await invitee.context.close();
  });
});

test.describe('kick or ban contribution purge modal', () => {
  test('prompts immediately after kicking or banning a user with two-step confirmation', async ({ browser }) => {
    const room = uniqueRoom('purge');
    const teacher = await newUser(browser);
    const disruptor = await newUser(browser);
    const peer = await newUser(browser);

    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(disruptor.page, room, 'Rowdy');
    await joinRoom(peer.page, room, 'GoodKid');

    // Disruptor draws a stroke and sends a chat message; GoodKid sends a chat message
    await drawStroke(disruptor.page);
    const disruptorInput = disruptor.page.getByPlaceholder('Message the class...');
    await disruptorInput.fill('Distracting chat!');
    await disruptorInput.press('Enter');

    const peerInput = peer.page.getByPlaceholder('Message the class...');
    await peerInput.fill('Helpful note');
    await peerInput.press('Enter');

    await expect(teacher.page.getByText('Distracting chat!')).toBeVisible();
    await expect(teacher.page.getByText('Helpful note')).toBeVisible();

    // Teacher kicks Rowdy -> follow-up modal pops up right away; clicking No preserves contributions
    await teacher.page.getByRole('button', { name: /^Class/ }).click();
    await teacher.page.getByTitle('Kick or Ban Rowdy').click();
    await teacher.page.getByRole('button', { name: 'Kick', exact: true }).click();

    const dialog = teacher.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('Delete all their contributions to the room (chat messages, drawings, annotations)?')
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Rowdy was kicked to lobby, but contributions remain
    await expect(disruptor.page.getByText(`You were removed from room #${room}`)).toBeVisible();
    await teacher.page.getByRole('button', { name: /^Chat/ }).click();
    await expect(teacher.page.getByText('Distracting chat!')).toBeVisible();

    // Teacher bans Rowdy (now listed offline via ink), clicks Yes -> "Are you really sure?" -> No keeps contributions
    await teacher.page.getByRole('button', { name: /^Class/ }).click();
    await teacher.page.getByTitle('Kick or Ban Rowdy').click();
    await teacher.page.getByRole('button', { name: 'Ban', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(dialog.getByText('Are you really sure?')).toBeVisible();
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await teacher.page.getByRole('button', { name: /^Chat/ }).click();
    await expect(teacher.page.getByText('Distracting chat!')).toBeVisible();

    // Teacher bans/kicks Rowdy again, clicks Yes -> "Are you really sure?" -> Yes -> deletes it all ASAP!
    await teacher.page.getByRole('button', { name: /^Class/ }).click();
    await teacher.page.getByTitle('Kick or Ban Rowdy').click();
    await teacher.page.getByRole('button', { name: 'Ban', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(dialog.getByText('Are you really sure?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Disruptor's chat & ink are gone for both teacher and peer; peer's message stays
    await expect(peer.page.getByText('Distracting chat!')).toHaveCount(0);
    await expect(peer.page.getByText('Helpful note')).toBeVisible();
    await teacher.page.getByRole('button', { name: /^Chat/ }).click();
    await expect(teacher.page.getByText('Distracting chat!')).toHaveCount(0);
    await expect(teacher.page.getByText('Helpful note')).toBeVisible();

    await teacher.context.close();
    await disruptor.context.close();
    await peer.context.close();
  });

  test('teacher sees Teacher stamps bar and can place feedback stamps while students cannot', async ({ browser }) => {
    const room = uniqueRoom('t-stamps');
    const teacher = await newUser(browser);
    const student = await newUser(browser);
    await joinRoom(teacher.page, room, 'Ms T', PIN);
    await joinRoom(student.page, room, 'Sam');

    // Switch both to Stamp tool
    await teacher.page.getByRole('button', { name: /Quick Stamp Tool/i }).click();
    await student.page.getByRole('button', { name: /Quick Stamp Tool/i }).click();

    // Teacher sees Teacher stamps group; student only sees student stamps
    const teacherGroup = teacher.page.getByTestId('teacher-stamps-group');
    await expect(teacherGroup).toBeVisible();
    await expect(teacherGroup.getByRole('button', { name: 'APPROVED', exact: true })).toBeVisible();
    await expect(teacherGroup.getByRole('button', { name: 'DENIED', exact: true })).toBeVisible();
    await expect(teacherGroup.getByRole('button', { name: 'NEEDS WORK', exact: true })).toBeVisible();
    await expect(teacherGroup.getByRole('button', { name: 'INCOMPLETE', exact: true })).toBeVisible();
    await expect(teacherGroup.getByRole('button', { name: 'LATE', exact: true })).toBeVisible();
    await expect(student.page.getByTestId('teacher-stamps-group')).toHaveCount(0);

    // Teacher places an APPROVED stamp and a CUSTOM rubber stamp
    await teacherGroup.getByRole('button', { name: 'APPROVED', exact: true }).click();
    const box = await teacher.page.locator('canvas').first().boundingBox();
    expect(box).not.toBeNull();
    await teacher.page.mouse.click(box!.x + 180, box!.y + 180);

    await teacherGroup.getByRole('button', { name: 'CUSTOM', exact: true }).click();
    await teacher.page.getByLabel('Custom teacher stamp text').fill('great graph');
    await teacher.page.mouse.click(box!.x + 340, box!.y + 220);

    // Both stamps recorded on teacher's contribution row (2 items)
    const tRow = await rosterRow(teacher.page, 'Ms T');
    await expect(tRow).toContainText('2 items');

    await teacher.context.close();
    await student.context.close();
  });
});

test.describe('room name display', () => {
  test('shows full room code in sidebar, tab title, and hidden-sidebar chip', async ({ page }) => {
    const room = 'period-3-biology-lab';
    await joinRoom(page, room, 'Ms T');

    await expect(page).toHaveTitle(`#${room} · AllAboard`);

    const roomButton = page.getByTitle('Click to enter a different room code');
    await expect(roomButton).toHaveText(room);
    const fitsWithoutTruncation = await roomButton.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fitsWithoutTruncation).toBe(true);

    await expect(page.getByTestId('room-chip')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide chat sidebar' }).click();

    const chip = page.getByTestId('room-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(`Room: ${room}`);
  });
});
