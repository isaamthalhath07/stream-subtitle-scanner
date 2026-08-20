const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  page.on('response', async (response) => {
    const url = response.url();
    
    // Log m3u8 and vtt
    if (url.includes('.m3u8') || url.includes('.vtt') || url.includes('subtitle') || url.includes('sbtl')) {
      console.log(`[MEDIA] ${url.substring(0, 150)}`);
      if (url.includes('.m3u8') && url.includes('sub')) {
        const text = await response.text();
        fs.writeFileSync('subtitle_playlist.m3u8', text);
        console.log(`Saved subtitle playlist: ${url}`);
      }
    }
  });

  console.log('Navigating to Euphoria S1E1...');
  await page.goto('https://www.hotstar.com/in/shows/euphoria/1971002893/pilot/1971003444/watch', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // Wait for player and ads
  console.log('Waiting 30 seconds for ads to finish and player to start...');
  await new Promise(r => setTimeout(r, 30000));
  
  await browser.close();
})();
