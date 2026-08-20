#!/usr/bin/env node
'use strict';
// APPROACH: Instead of launching Chrome (which fails because it's already running),
// we'll connect to the RUNNING Chrome instance via its DevTools protocol.
// First, we launch a small Chrome process with --remote-debugging-port to get
// the WebSocket URL, then connect Puppeteer to it.
//
// Actually, the cleanest approach for Hotstar: use the chrome_hotstar_profile 
// (which CAN launch fine) and handle the login issue by extracting cookies 
// from the Default profile's cookie DB file.

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const http = require('http');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const HOTSTAR_PROFILE = path.join(__dirname, 'chrome_hotstar_profile');

async function launchWithDebugPort() {
  // Try to launch Chrome with a debug port using the Default profile
  // If Chrome is already running, we start a NEW instance with a different 
  // user-data-dir but copy the cookies
  return new Promise(async (resolve, reject) => {
    // First try: connect to running Chrome if it has debug port
    try {
      const resp = await fetch('http://127.0.0.1:9222/json/version');
      const data = await resp.json();
      console.log('Found running Chrome with debug port!');
      const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl });
      return resolve(browser);
    } catch (e) {
      // Chrome isn't running with debug port
    }

    // Second try: launch Chrome with Default profile
    try {
      const browser = await puppeteer.launch({
        headless: false, defaultViewport: null,
        executablePath: CHROME_PATH, userDataDir: PROFILE_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox',
               '--disable-background-timer-throttling',
               '--disable-backgrounding-occluded-windows',
               '--disable-renderer-backgrounding',
               '--disable-extensions', '--no-first-run', '--no-default-browser-check']
      });
      console.log('Launched Chrome with Default profile.');
      return resolve(browser);
    } catch (e) {
      console.log('Default profile locked. Using fallback approach...');
    }

    // Third try: Launch Chrome with a temp profile, then open Hotstar
    // and have user manually log in if needed... BUT we can copy cookies!
    // Spawn chrome.exe with --remote-debugging-port and reuse existing session
    console.log('Starting Chrome with debug port on running instance...');
    const chrome = spawn(CHROME_PATH, [
      `--remote-debugging-port=9222`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run'
    ], { stdio: 'ignore', detached: true });
    chrome.unref();
    
    // Wait for debug port to become available
    await new Promise(r => setTimeout(r, 3000));
    
    try {
      const resp = await fetch('http://127.0.0.1:9222/json/version');
      const data = await resp.json();
      console.log('Connected to Chrome via debug port!');
      const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl });
      return resolve(browser);
    } catch (e) {
      // Final fallback: use the hotstar profile (no auth but can resolve episodes)
      console.log('Debug port failed. Using hotstar profile...');
      const browser = await puppeteer.launch({
        headless: false, defaultViewport: null,
        executablePath: CHROME_PATH, userDataDir: HOTSTAR_PROFILE,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run']
      });
      return resolve(browser);
    }
  });
}

(async () => {
  console.log('=== HOTSTAR SUBTITLE DEBUG v3 ===\n');
  
  const browser = await launchWithDebugPort();
  console.log('Browser connected.\n');
  
  // Step 1: Resolve episodes
  console.log('Step 1: Resolving Euphoria episodes...');
  const showUrl = 'https://www.hotstar.com/in/shows/euphoria/1971002893';
  const resolvePage = await browser.newPage();
  
  const episodeMap = {};
  let resolvedEpisodes = false;
  
  resolvePage.on('response', async (response) => {
    if (resolvedEpisodes) return;
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    
    if (ct.includes('application/json') && url.includes('hotstar.com')) {
      try {
        const text = await response.text();
        if (!text.includes('playable_content')) return;
        const j = JSON.parse(text);
        
        const findItems = (obj) => {
          if (!obj || typeof obj !== 'object') return [];
          let items = [];
          if (Array.isArray(obj)) {
            for (const item of obj) {
              if (item?.playable_content?.data) items.push(item.playable_content.data);
              items = items.concat(findItems(item));
            }
          } else {
            for (const val of Object.values(obj)) items = items.concat(findItems(val));
          }
          return items;
        };
        
        for (const data of findItems(j)) {
          if (!data.content_id || !data.title) continue;
          const tagValue = data.tags?.find(t => t.value?.match(/S\d+\s+E\d+/))?.value;
          const slug = data.actions?.on_click?.find(a => a.page_navigation)?.page_navigation?.page_slug;
          if (tagValue && slug) {
            const match = tagValue.match(/S(\d+)\s+E(\d+)/);
            if (match) {
              const e = parseInt(match[2]);
              episodeMap[e] = {
                season: parseInt(match[1]), episode: e,
                contentId: data.content_id, title: data.title,
                url: `https://www.hotstar.com${slug}`
              };
            }
          }
        }
      } catch (e) {}
    }
  });
  
  await resolvePage.goto(showUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));
  resolvedEpisodes = true;
  await resolvePage.close().catch(() => {});
  
  console.log(`Found ${Object.keys(episodeMap).length} episodes:`);
  for (const [ep, info] of Object.entries(episodeMap)) {
    console.log(`  E${ep}: "${info.title}" (${info.contentId}) → ${info.url}`);
  }
  
  if (!episodeMap[1]) {
    console.error('E1 not found!');
    await browser.close();
    return;
  }
  
  // Step 2: Go to S1E1 watch page and capture EVERYTHING
  const ep = episodeMap[1];
  console.log(`\nStep 2: Going to ${ep.url}`);
  const watchPage = await browser.newPage();
  
  const mediaResponses = [];
  
  watchPage.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    const status = response.status();
    
    // Capture media-related responses
    const isMedia = url.includes('.m3u8') || url.includes('.mpd') || url.includes('.vtt') ||
        url.includes('sbtl') || url.includes('subtitle') || url.includes('caption') ||
        ct.includes('mpegurl') || ct.includes('vtt') || ct.includes('dash+xml') ||
        url.includes('master') || url.includes('manifest');
    
    if (isMedia) {
      try {
        const text = await response.text();
        console.log(`\n  [MEDIA ${status}] ${ct}`);
        console.log(`  ${url.substring(0, 200)}`);
        console.log(`  ${text.length} bytes`);
        
        // Show content for m3u8 and small VTT files
        if (url.includes('.m3u8') || text.length < 2000) {
          console.log(`  ---\n${text.substring(0, 500)}\n  ---`);
        }
        
        mediaResponses.push({ url, ct, status, text });
      } catch (e) {}
    }
  });
  
  try {
    await watchPage.goto(ep.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log(`Nav: ${e.message.substring(0, 100)}`);
  }
  
  await new Promise(r => setTimeout(r, 5000));
  await watchPage.screenshot({ path: 'debug_watch_1.png' });
  console.log('\n📸 Screenshot 1');
  console.log('URL:', watchPage.url());
  
  const bodyText = await watchPage.evaluate(() => document.body?.innerText?.substring(0, 300) || '').catch(() => '');
  console.log('Body:', bodyText.substring(0, 200));
  const isPaywall = bodyText.includes('Subscribe') || bodyText.includes('Login') || bodyText.includes('paywall');
  console.log('Paywall:', isPaywall);
  
  // Wait for video player
  console.log('\nWaiting 30s for video/ads...');
  await new Promise(r => setTimeout(r, 30000));
  await watchPage.screenshot({ path: 'debug_watch_2.png' });
  console.log('📸 Screenshot 2');
  
  // Results
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MEDIA: ${mediaResponses.length}`);
  const vttCount = mediaResponses.filter(m => m.url.includes('.vtt') || m.ct?.includes('vtt')).length;
  const m3u8Count = mediaResponses.filter(m => m.url.includes('.m3u8') || m.ct?.includes('mpegurl')).length;
  const mpdCount = mediaResponses.filter(m => m.url.includes('.mpd') || m.ct?.includes('dash')).length;
  console.log(`  VTT: ${vttCount} | M3U8: ${m3u8Count} | MPD: ${mpdCount}`);
  
  // Check m3u8 for subtitle references
  for (const m of mediaResponses) {
    if (m.text.includes('SUBTITLES') || m.text.includes('sbtl')) {
      console.log(`\n★ M3U8 with subtitle refs:\n${m.text.substring(0, 1500)}`);
    }
  }
  
  fs.writeFileSync('debug_media_v3.json', JSON.stringify(mediaResponses.map(m => ({
    url: m.url, ct: m.ct, status: m.status, size: m.text.length,
    preview: m.text.substring(0, 3000)
  })), null, 2));
  
  await watchPage.close().catch(() => {});
  await browser.close().catch(() => {});
  console.log('\nDone.');
})();
