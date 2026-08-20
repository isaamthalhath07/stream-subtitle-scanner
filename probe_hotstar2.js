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
  
  let counter = 0;
  
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    
    // Capture ALL JSON API responses from hotstar
    if (ct.includes('application/json') && (url.includes('hotstar.com') || url.includes('usersvc'))) {
      try {
        const text = await response.text();
        if (text.length > 100) {
          counter++;
          const fname = `hs_resp_${counter}_${Date.now()}.json`;
          fs.writeFileSync(fname, text);
          console.log(`[${counter}] ${url.substring(0, 150)} (${text.length} bytes) -> ${fname}`);
        }
      } catch (e) {}
    }
  });

  const showUrl = process.argv[2] || 'https://www.hotstar.com/in/shows/loki/1260063451';
  console.log(`\nNavigating to: ${showUrl}\n`);
  await page.goto(showUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait for dynamic content to load
  await new Promise(r => setTimeout(r, 8000));
  
  // Now scroll down to trigger episode list loading
  console.log('\nScrolling to episode section...');
  await page.evaluate(() => window.scrollTo(0, 800));
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => window.scrollTo(0, 1500));
  await new Promise(r => setTimeout(r, 3000));
  
  console.log(`\nTotal responses captured: ${counter}`);
  await browser.close();
})();
