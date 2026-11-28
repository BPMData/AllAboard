import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { drawStroke, joinRoom, newUser, uniqueRoom } from './helpers';

test('a built classroom shares ink and a PDF worksheet between two browsers', async ({ page, browser }) => {
  const room = uniqueRoom('built');
  await joinRoom(page, room, 'Teacher', '4829');
  const student = await newUser(browser);
  try {
    await joinRoom(student.page, room, 'Student');
    await drawStroke(student.page);
    await page
      .locator('input[type="file"][accept*="application/pdf"]')
      .setInputFiles('thanksgiving-bug-bingo/four_corners.pdf');
    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    const download = student.page.waitForEvent('download');
    await student.page.getByRole('button', { name: 'Save class work' }).click();
    const saved = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
    expect(saved.elements).toHaveLength(1);
    expect(saved.background.fileName).toBe('four_corners.pdf');
    expect(saved.background.pages.length).toBeGreaterThan(0);
    expect(Object.keys(saved.assets).length).toBeGreaterThan(0);
    const teacherDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save class work' }).click();
    const teacherCopy = JSON.parse(await readFile((await (await teacherDownload).path())!, 'utf8'));
    expect(teacherCopy.elements[0].id).toBe(saved.elements[0].id);
  } finally {
    await student.context.close();
  }
});
