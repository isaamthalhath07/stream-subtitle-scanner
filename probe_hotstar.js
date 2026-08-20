#!/usr/bin/env node
'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(__dirname, 'chrome_hotstar_profile');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-extensions',
           '--disable-component-extensions-with-background-pages',
           '--no-first-run','--no-default-browser-check']
  });

  const page = await browser.newPage();
  
  // Track all API calls
  const apiCalls = [];
  const vttCaptures = [];
  
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    // Log BFF/API calls
    if (url.includes('apix.hotstar.com') || url.includes('/v2/pages') || url.includes('/v1/') || url.includes('/o/v1/') || url.includes('bff')) {
      apiCalls.push({
        url: url.substring(0, 300),
        method: req.method(),
        headers: req.headers()
      });
      console.log(`[API] ${req.method()} ${url.substring(0, 200)}`);
    }
    req.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    
    // Capture subtitle/VTT requests
    if (url.includes('.vtt') || url.includes('sbtl') || url.includes('subtitle') || ct.includes('text/vtt')) {
      console.log(`[VTT] ${url.substring(0, 200)}`);
      try {
        const text = await response.text();
        vttCaptures.push({ url, text: text.substring(0, 500) });
      } catch (e) {}
    }
    
    // Capture page/detail API responses 
    if ((url.includes('apix.hotstar.com') || url.includes('/v2/pages') || url.includes('/detail')) && ct.includes('json')) {
      try {
        const text = await response.text();
        const j = JSON.parse(text);
        console.log(`[API RESP] ${url.substring(0, 150)} — keys: ${Object.keys(j).join(',')}`);
        // Save interesting API responses
        const fname = 'hotstar_api_' + Date.now() + '.json';
        fs.writeFileSync(fname, JSON.stringify(j, null, 2));
        console.log(`  Saved to ${fname}`);
      } catch (e) {}
    }
  });

  // Navigate to a show page with episode list
  const showUrl = process.argv[2] || 'https://www.hotstar.com/in/shows/loki/1260063451';
  console.log(`\nNavigating to: ${showUrl}\n`);
  await page.goto(showUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait extra for dynamic content
  await new Promise(r => setTimeout(r, 5000));
  
  console.log(`\n--- Summary ---`);
  console.log(`API calls captured: ${apiCalls.length}`);
  console.log(`VTT captures: ${vttCaptures.length}`);
  
  if (apiCalls.length > 0) {
    console.log('\nFirst API call headers:');
    const first = apiCalls[0];
    console.log(JSON.stringify(first.headers, null, 2));
  }
  
  // Save all captured data
  fs.writeFileSync('hotstar_probe_results.json', JSON.stringify({
    apiCalls: apiCalls.map(a => ({ url: a.url, method: a.method, headers: a.headers })),
    vttCaptures
  }, null, 2));
  console.log('\nSaved probe results to hotstar_probe_results.json');
  
  // Keep browser open for 10s more to catch late requests
  console.log('\nWaiting 10s for late requests...');
  await new Promise(r => setTimeout(r, 10000));
  
  console.log(`\nFinal: ${apiCalls.length} API calls, ${vttCaptures.length} VTT captures`);
  
  await browser.close();
})();
