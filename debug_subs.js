const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchHtml(new URL(res.headers.location, url).href));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function captureSubtitles() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('GetPlaybackResources') || url.includes('.ttml2') || url.includes('.dfxp') || url.includes('.xml')) {
      console.log('Intercepted:', url);
      try {
        const text = await res.text();
        fs.writeFileSync('debug_intercept.txt', text + '\n\n', {flag: 'a'});
      } catch(e) {}
    }
  });

  try {
    const episodeUrl = 'https://www.amazon.co.uk/gp/video/detail/B0875L16ZV/';
    console.log('Navigating...');
    await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    console.log('Clicking play...');
    await page.evaluate(() => {
      const playBtn = document.querySelector('[data-automation-id="ep-play-button"], .dv-play-button');
      if (playBtn) playBtn.click();
    });
    
    await new Promise(r => setTimeout(r, 10000));
    
  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}
captureSubtitles().then(() => console.log('Done'));
