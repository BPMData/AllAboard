/**
 * Regression: a big dragged stroke with the hollow shape brush (star, square, triangle, diamond)
 * made the board crawl until all ink was cleared. Two causes:
 *  1. Every React render (each mouse move, remote cursor, chat message) handed Konva a brand-new
 *     draw function, so every ink layer repainted all of its strokes on every mouse move.
 *  2. Each repaint of a hollow shape stroke filled thousands of overlapping shape copies as one path.
 * This checks cause 1 in a real browser: after the stroke is drawn, just moving the mouse must not
 * repaint the ink. (Cause 2 is covered by tests/inkCore.test.ts.)
 */
import { expect, test } from '@playwright/test';
import { joinRoom, uniqueRoom } from './helpers';

test('a big hollow star stroke does not repaint on every mouse move', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('allaboard-hollow-shape', 'star');
    const w = window as unknown as { __fills: number };
    w.__fills = 0;
    const origFill = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      w.__fills += 1;
      return (origFill as (...a: unknown[]) => void).apply(this, args);
    } as typeof origFill;
  });

  await joinRoom(page, uniqueRoom('hollow-perf'), 'Star Painter');

  // First click picks the hollow brush and opens its shape menu; the second click closes the menu.
  const hollowButton = page.getByTitle(/^Hollow Star Brush/);
  await hollowButton.click();
  await hollowButton.click();
  await expect(page.getByRole('menu', { name: 'Hollow brush shapes' })).toHaveCount(0);

  // A long zig-zag stroke across the middle of the board.
  await page.mouse.move(600, 400);
  await page.mouse.down();
  for (let i = 1; i <= 160; i++) {
    const x = 600 + (i % 20 < 10 ? (i % 10) * 50 : (10 - (i % 10)) * 50);
    const y = 400 + i * 1.5;
    await page.mouse.move(x, y);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const fillsWhileDrawing = await page.evaluate(() => (window as unknown as { __fills: number }).__fills);
  expect(fillsWhileDrawing, 'the star stroke was painted').toBeGreaterThan(0);

  await page.evaluate(() => {
    (window as unknown as { __fills: number }).__fills = 0;
  });
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(650 + i * 10, 700 - i * 4);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(300);

  const fillsWhileHovering = await page.evaluate(() => (window as unknown as { __fills: number }).__fills);
  // Before the fix every hover move repainted the stroke (dozens of fills). Now the ink layer stays put.
  expect(fillsWhileHovering).toBeLessThan(10);
});
