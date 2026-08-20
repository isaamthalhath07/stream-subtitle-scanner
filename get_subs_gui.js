const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');
const path = require('path');

function extractDomain(url) {
  const m = url.match(/https?:\/\/(www\.[^/]+)/);
  return m ? m[1] : 'www.amazon.co.uk';
}

function extractAsin(url) {
  const m = url.match(/\/(?:dp|detail|product)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Z0-9]{10}$/i.test(url)) return url.toUpperCase();
  return null;
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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

async function resolveEpisodeUrl(showUrl, targetSeason, targetEpisode) {
  const showAsin = extractAsin(showUrl);
  const domain = extractDomain(showUrl);
  console.log(`[1] Resolving S${targetSeason}E${targetEpisode} for ${showAsin}...`);
  const startUrl = `https://${domain}/gp/video/detail/${showAsin}/`;
  
  let html = await fetchHtml(startUrl);
  let match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
  let data = match ? JSON.parse(match[1]) : null;
  
  const seasonsMap = data.init.preparations.body.atf.state.seasons;
  const seasonsList = seasonsMap[showAsin] || Object.values(seasonsMap)[0];
  const seasonObj = seasonsList.find(s => s.sequenceNumber === targetSeason);
  
  if (!seasonObj.isSelected) {
    const seasonUrl = `https://${domain}/gp/video/detail/${seasonObj.seasonId}/`;
    html = await fetchHtml(seasonUrl);
    match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
    data = match ? JSON.parse(match[1]) : null;
  }
  
  const episodes = data.init.preparations.body.btf.state.detail.detail;
  for (const [asin, details] of Object.entries(episodes)) {
    if (details.episodeNumber === targetEpisode) {
      return `https://${domain}/gp/video/detail/${asin}/`;
    }
  }
  throw new Error("Episode not found");
}

async function captureSubtitles(episodeUrl, season, episode) {
  console.log(`[2] Launching REAL Google Chrome (with Persistent Profile)...`);
  
  const browser = await puppeteer.launch({
    headless: false, 
    defaultViewport: null,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    userDataDir: path.join(__dirname, 'chrome_subs_profile'),
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  let capturedSub = null;
  
  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    
    if (url.includes('GetPlaybackResources') || contentType.includes('application/json')) {
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        if (data.catalogMetadata && data.catalogMetadata.catalog.entityType !== 'Trailer' && data.subtitleUrls) {
          const subs = data.subtitleUrls;
          const enSub = subs.find(s => s.languageCode.includes('en'));
          if (enSub) {
            console.log(`  -> Found Episode JSON! Subtitle URL: ${enSub.url}`);
            capturedSub = enSub.url;
          }
        }
      } catch (err) {}
    }
    
    if ((url.includes('.ttml2') || url.includes('.dfxp')) && !contentType.includes('json')) {
      try {
        const buffer = await response.buffer();
        if (buffer.length > 50000) { 
          console.log(`  -> Captured real TTML2 file: ${buffer.length} bytes`);
          capturedSub = buffer.toString('utf8');
        }
      } catch (err) {}
    }
  });

  try {
    await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 0 });
    console.log(`[3] Waiting up to 180 seconds for you to log in (if needed) and play the video...`);
    
    for (let i = 0; i < 180; i++) {
      if (capturedSub) break;
      await new Promise(r => setTimeout(r, 1000));
      
      try {
        await page.evaluate(() => {
          const playBtn = document.querySelector('[data-automation-id="ep-play-button"], .dv-play-button');
          if (playBtn) playBtn.click();
        });
      } catch(e) {}
    }
    
  } catch (err) {
    console.error(`[!] Navigation error: ${err.message}`);
  } finally {
    await browser.close();
  }
  
  if (!capturedSub) {
    console.error(`[!] No subtitles captured.`);
    process.exit(1);
  }
  
  const filename = `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}_subtitles.xml`;
  
  if (capturedSub.startsWith('http')) {
    console.log(`[4] Downloading TTML2 from extracted URL...`);
    const content = await fetchHtml(capturedSub);
    fs.writeFileSync(filename, content);
  } else {
    fs.writeFileSync(filename, capturedSub);
  }
  console.log(`[5] ✅ Saved subtitles to: ${filename}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node get_subs_gui.js <show_url> <season_number> <episode_number>');
    process.exit(1);
  }
  
  const showUrl = args[0];
  const targetSeason = parseInt(args[1], 10);
  const targetEpisode = parseInt(args[2], 10);

  try {
    const url = await resolveEpisodeUrl(showUrl, targetSeason, targetEpisode);
    await captureSubtitles(url, targetSeason, targetEpisode);
  } catch(e) {
    console.error(e);
  }
}
main();
