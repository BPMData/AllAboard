/**
 * Regression: the brush/stamp preview follows the pointer's world position, which starts at (0,0).
 * Before the pointer ever reached the canvas it drew a tiny dashed arc at the board's top-left corner.
 */
import { expect, test, type Page } from '@playwright/test';
import { joinRoom, uniqueRoom } from './helpers';

/** Highest alpha drawn by any Konva canvas inside a box (in CSS px, relative to .konvajs-content). */
async function maxInkAlpha(page: Page, box: { x: number; y: number; w: number; h: number }) {
  return page.evaluate(({ x, y, w, h }) => {
    let max = 0;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>('.konvajs-content canvas')) {
      const ratio = canvas.width / canvas.clientWidth || 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const data = ctx.getImageData(x * ratio, y * ratio, Math.max(1, w * ratio), Math.max(1, h * ratio)).data;
      for (let i = 3; i < data.length; i += 4) max = Math.max(max, data[i]);
    }
    return max;
  }, box);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`a fresh board draws nothing at its top-left corner (${viewport.width}x${viewport.height})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await joinRoom(page, uniqueRoom('corner'), 'Corner Check');
    await expect(page.locator('.konvajs-content canvas').first()).toBeVisible();
    await page.waitForTimeout(300); // let Konva finish its first draw
    expect(await maxInkAlpha(page, { x: 0, y: 0, w: 16, h: 16 })).toBe(0);
  });
}

test('the brush preview still follows the pointer once it is over the board', async ({ page }) => {
  await joinRoom(page, uniqueRoom('corner-hover'), 'Hover Check');
  const content = await page.locator('.konvajs-content').boundingBox();
  if (!content) throw new Error('no Konva stage');
  const at = { x: Math.round(content.width / 2), y: Math.round(content.height / 2) };
  await page.mouse.move(content.x + at.x - 20, content.y + at.y - 20);
  await page.mouse.move(content.x + at.x, content.y + at.y);
  await expect.poll(() => maxInkAlpha(page, { x: at.x - 30, y: at.y - 30, w: 60, h: 60 })).toBeGreaterThan(0);
  expect(await maxInkAlpha(page, { x: 0, y: 0, w: 16, h: 16 })).toBe(0);
});
