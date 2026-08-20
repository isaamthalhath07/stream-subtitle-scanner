const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_PROFILE = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Google', 'Chrome', 'TempHotstarProfile');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: CHROME_PATH,
    userDataDir: TEMP_PROFILE,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  console.log('Navigating to Euphoria S1E1...');
  await page.goto('https://www.hotstar.com/in/shows/euphoria/1971002893/pilot/1971003444/watch', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  await new Promise(r => setTimeout(r, 10000));
  await page.screenshot({ path: 'euphoria_test.png' });
  console.log('Saved screenshot to euphoria_test.png');
  console.log('Page URL:', page.url());
  
  await browser.close();
})();
