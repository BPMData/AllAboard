import { expect, type Browser, type Page } from '@playwright/test';

export const uniqueRoom = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Join a room through the real lobby form. Pass a PIN to join as the teacher. */
export async function joinRoom(page: Page, room: string, name: string, pin?: string) {
  await page.goto(`/?room=${room}`);
  await page.getByLabel('Your Display Name').fill(name);
  if (pin) {
    await page.getByText('Instructor? Set or enter a room Teacher PIN').click();
    await page.locator('#teacher-pin-input').fill(pin);
  }
  await page.getByRole('button', { name: 'Join Classroom' }).click();
  await expect(page.getByPlaceholder('Message the class...')).toBeVisible();
  if (pin) await expect(page.getByText('Teacher Active')).toBeVisible();
}

/** Open a page in its own browser context (separate localStorage = separate user). */
export async function newUser(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/** Drag a freehand stroke across the middle of the board. */
export async function drawStroke(page: Page, from = { x: 700, y: 400 }, to = { x: 1000, y: 600 }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
}
