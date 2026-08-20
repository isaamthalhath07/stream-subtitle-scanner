const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITY: HTTP Fetch
// ═══════════════════════════════════════════════════════════════════════════
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
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchHtml(next));
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 1: Fast Episode Resolution via Hydration Data
// ═══════════════════════════════════════════════════════════════════════════
function extractHydrationData(html) {
  const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
  return match ? JSON.parse(match[1]) : null;
}

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

async function resolveEpisodeUrl(showUrl, targetSeason, targetEpisode) {
  const showAsin = extractAsin(showUrl);
  const domain = extractDomain(showUrl);
  if (!showAsin) throw new Error("Could not extract ASIN from URL");

  console.log(`[1] Resolving S${targetSeason}E${targetEpisode} for ${showAsin} on ${domain}...`);
  const startUrl = `https://${domain}/gp/video/detail/${showAsin}/`;
  
  let html = await fetchHtml(startUrl);
  let data = extractHydrationData(html);
  
  if (!data) throw new Error("Could not find hydration data. Amazon might have changed their page structure.");
  
  const seasonsMap = data.init.preparations.body.atf.state.seasons;
  const seasonsList = seasonsMap[showAsin] || Object.values(seasonsMap)[0];
  if (!seasonsList) throw new Error("Could not find season list in hydration data.");
  
  const seasonObj = seasonsList.find(s => s.sequenceNumber === targetSeason);
  if (!seasonObj) throw new Error(`Season ${targetSeason} not found in show data.`);
  
  if (!seasonObj.isSelected) {
    console.log(`[1a] Fetching specific page for Season ${targetSeason} (ASIN: ${seasonObj.seasonId})...`);
    const seasonUrl = `https://${domain}/gp/video/detail/${seasonObj.seasonId}/`;
    html = await fetchHtml(seasonUrl);
    data = extractHydrationData(html);
    if (!data) throw new Error("Could not find hydration data on season page.");
  }
  
  const episodes = data.init.preparations.body.btf.state.detail.detail;
  for (const [asin, details] of Object.entries(episodes)) {
    if (details.episodeNumber === targetEpisode) {
      const epUrl = `https://${domain}/gp/video/detail/${asin}/`;
      console.log(`[1b] Resolved Episode ASIN: ${asin} -> ${epUrl}`);
      return epUrl;
    }
  }
  
  throw new Error(`Episode ${targetEpisode} not found in season ${targetSeason}.`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 2 & 3: Browser Automation & Subtitle Capture
// ═══════════════════════════════════════════════════════════════════════════
async function captureSubtitles(episodeUrl, season, episode, debugPort, cookiesString) {
  console.log(`[2] Launching browser to capture subtitles...`);
  
  let browser;
  if (debugPort) {
    console.log(`    Connecting to active Chrome session on port ${debugPort}...`);
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    } catch (err) {
      console.error(`[!] Failed to connect to active Chrome. Make sure Chrome is running with --remote-debugging-port=${debugPort}`);
      process.exit(1);
    }
  } else {
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--autoplay-policy=no-user-gesture-required'];
    browser = await puppeteer.launch({ headless: "new", args });
  }
  
  const page = await browser.newPage();
  
  if (!debugPort) {
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    
    if (cookiesString) {
      console.log(`    Injecting provided cookies...`);
      const cookiesArr = cookiesString.split(';').map(c => {
        const [name, ...val] = c.split('=');
        return { name: name.trim(), value: val.join('=').trim(), domain: extractDomain(episodeUrl) };
      });
      await page.setCookie(...cookiesArr);
    }
  }
  
  const capturedSubs = [];
  
  console.log(`[3] Navigating to Episode URL and monitoring network for TTML2...`);
  
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('.ttml2') || url.includes('.dfxp')) {
      try {
        const buffer = await response.buffer();
        if (buffer.length > 1000) {
          capturedSubs.push({
            url,
            size: buffer.length,
            content: buffer.toString('utf8')
          });
          console.log(`  -> Captured TTML2 response: ${buffer.length} bytes`);
        }
      } catch (err) {
        // Ignore
      }
    }
  });

  try {
    await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log(`[4] Page loaded. Attempting to click Play if it doesn't autoplay...`);
    
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
      for (const b of buttons) {
        const text = (b.textContent || '').trim().toLowerCase();
        if (text === 'play episode' || text === 'resume episode' || text === 'watch episode') {
          b.click();
          return;
        }
      }
      const playBtn = document.querySelector('[data-automation-id="ep-play-button"], .dv-play-button');
      if (playBtn) playBtn.click();
    });
    
    console.log(`[5] Waiting 15 seconds for DRM/player initialization and subtitle fetch...`);
    await new Promise(r => setTimeout(r, 15000));
    
  } catch (err) {
    console.error(`[!] Navigation error: ${err.message}`);
  } finally {
    if (debugPort) {
      await page.close();
      browser.disconnect();
    } else {
      await browser.close();
    }
  }
  
  if (capturedSubs.length === 0) {
    console.error(`\n[!] No TTML2 subtitles were captured.`);
    console.error(`    This usually means you are not logged into Amazon, so the video cannot play.`);
    console.error(`    Ensure you are passing valid cookies or connecting to an authenticated Chrome session.`);
    process.exit(1);
  }
  
  capturedSubs.sort((a, b) => b.size - a.size);
  const bestSub = capturedSubs[0];
  
  console.log(`[6] Selected largest subtitle file (${bestSub.size} bytes).`);
  
  const filename = `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}_subtitles.xml`;
  fs.writeFileSync(filename, bestSub.content);
  console.log(`[7] ✅ Saved subtitles to: ${filename}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node extract_subtitles.js <url> <season> <episode> [--port 9222] [--cookies "cookie_string"]');
    process.exit(1);
  }
  
  const showUrl = args[0];
  const targetSeason = parseInt(args[1], 10);
  const targetEpisode = parseInt(args[2], 10);
  
  let debugPort = null;
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && args[portIndex + 1]) debugPort = parseInt(args[portIndex + 1], 10);
  
  let cookiesString = null;
  const cookieIndex = args.indexOf('--cookies');
  if (cookieIndex !== -1 && args[cookieIndex + 1]) cookiesString = args[cookieIndex + 1];
  
  try {
    const episodeUrl = await resolveEpisodeUrl(showUrl, targetSeason, targetEpisode);
    await captureSubtitles(episodeUrl, targetSeason, targetEpisode, debugPort, cookiesString);
  } catch (err) {
    console.error('\nFatal Error:', err.message);
    process.exit(1);
  }
}

main();
