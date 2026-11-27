const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const n of ['four_corners', 'pictionary', 'bug_bingo', 'card_A', 'card_B', 'card_C', 'card_D']) {
    await p.goto('file://' + process.cwd() + '/' + n + '.html');
    await p.pdf({ path: n + '.pdf', width: '11in', height: '8.5in', printBackground: true });
  }
  await b.close();
})();
