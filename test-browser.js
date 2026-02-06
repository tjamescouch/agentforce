import puppeteer from 'puppeteer';

async function test() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Collect console logs
  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Collect errors
  const errors = [];
  page.on('pageerror', err => {
    errors.push(err.message);
  });

  // Track WebSocket connections
  const wsConnections = [];
  page.on('request', req => {
    if (req.url().includes('/ws') || req.resourceType() === 'websocket') {
      wsConnections.push({ url: req.url(), type: 'request' });
    }
  });
  page.on('requestfailed', req => {
    if (req.url().includes('/ws')) {
      wsConnections.push({ url: req.url(), type: 'failed', reason: req.failure()?.errorText });
    }
  });

  console.log('Navigating to dashboard...');
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 15000 });
  } catch (e) {
    console.log('Navigation timeout (expected for WebSocket apps)');
  }

  // Wait a bit for WebSocket to connect
  await new Promise(r => setTimeout(r, 3000));

  // Get page content
  const title = await page.title();
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));

  console.log('\n=== RESULTS ===\n');
  console.log('Page title:', title);
  console.log('\nPage content preview:\n', bodyText.slice(0, 300));

  console.log('\n--- Console Logs ---');
  consoleLogs.forEach(log => console.log(log));

  console.log('\n--- Errors ---');
  errors.forEach(err => console.log('ERROR:', err));

  console.log('\n--- WebSocket Activity ---');
  wsConnections.forEach(ws => console.log(ws));

  // Check if WebSocket connected by looking at page state
  const wsStatus = await page.evaluate(() => {
    // Check if there's any indication of connection in the page
    const statusEl = document.querySelector('.status');
    return statusEl ? statusEl.textContent : 'No status element found';
  });
  console.log('\nConnection status from page:', wsStatus);

  await browser.close();
  console.log('\nDone.');
}

test().catch(console.error);
