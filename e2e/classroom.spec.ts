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
});
