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
  
  page.on('response', async (response) => {
    const url = response.url();
    const type = response.headers()['content-type'] || '';
    if (url.includes('.m3u8') || url.includes('.vtt') || url.includes('.mpd') || url.includes('subtitle') || type.includes('vtt') || type.includes('mpegurl')) {
      console.log(`\n[MEDIA] ${url.substring(0, 200)}`);
      if (url.includes('.m3u8')) {
        try {
          const text = await response.text();
          console.log(`M3U8 CONTENTS:\n${text.substring(0, 500)}`);
        } catch(e) {}
      }
    }
  });

  console.log('Navigating to Euphoria S1E1...');
  await page.goto('https://www.hotstar.com/in/shows/euphoria/1971002893/pilot/1971003444/watch', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // Try to click play if necessary
  setTimeout(async () => {
    console.log('Attempting to click center of screen...');
    await page.mouse.click(500, 300);
  }, 10000);

  console.log('Waiting 30 seconds for player to start...');
  await new Promise(r => setTimeout(r, 30000));
  
  await browser.close();
})();
