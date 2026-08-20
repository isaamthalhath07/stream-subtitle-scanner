#!/usr/bin/env node
'use strict';
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// Quick test: fetch a Hotstar show page and extract __NEXT_DATA__
const url = 'https://www.hotstar.com/in/shows/loki/1260063451';

function httpGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip,deflate,br',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        console.log(`Redirect: ${res.statusCode} -> ${res.headers.location}`);
        return resolve(httpGet(new URL(res.headers.location, url).href, timeout));
      }
      console.log(`Status: ${res.statusCode}`);
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  console.log(`Fetching: ${url}`);
  const html = await httpGet(url);
  console.log(`HTML length: ${html.length}`);
  
  // Check for __NEXT_DATA__
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    console.log('\n✅ Found __NEXT_DATA__');
    const data = JSON.parse(nextDataMatch[1]);
    console.log('Top keys:', Object.keys(data));
    console.log('Props keys:', Object.keys(data.props || {}));
    if (data.props?.pageProps) {
      console.log('PageProps keys:', Object.keys(data.props.pageProps));
    }
    // Write it out
    require('fs').writeFileSync('hotstar_next_data.json', JSON.stringify(data, null, 2));
    console.log('Saved to hotstar_next_data.json');
  } else {
    console.log('\n❌ No __NEXT_DATA__ found');
    // Try other hydration patterns
    const scripts = html.match(/<script[^>]*>([\s\S]{100,}?)<\/script>/gi);
    console.log(`Found ${scripts?.length || 0} large script tags`);
    if (scripts) {
      for (let i = 0; i < Math.min(scripts.length, 5); i++) {
        const preview = scripts[i].substring(0, 200);
        console.log(`  Script ${i}: ${preview}...`);
      }
    }
    // Save full HTML for manual inspection
    require('fs').writeFileSync('hotstar_page.html', html);
    console.log('Saved full HTML to hotstar_page.html');
  }
})();
