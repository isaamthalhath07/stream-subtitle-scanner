#!/usr/bin/env node
/**
 * Amazon Prime Video — Episode URL Resolver
 * ──────────────────────────────────────────
 * Reverse-engineers Amazon's page data layer to resolve:
 *   (Show ASIN, Season N, Episode N) → Episode URL
 *
 * NO browser automation, NO DOM interaction, NO dropdowns.
 * 1-2 HTTP requests → JSON/HTML parse → URL.
 *
 * Usage:
 *   node resolve_episode.js <show_url_or_asin> <season> <episode> [--domain amazon.co.uk]
 *
 * Examples:
 *   node resolve_episode.js B0DWSGK5GS 1 3
 *   node resolve_episode.js "https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/" 1 3
 *   node resolve_episode.js B0DWSGK5GS 2 5 --domain amazon.com
 *
 * Requirements: Node >= 18 (uses built-in fetch)
 */
'use strict';

const https = require('https');

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const DEFAULT_DOMAIN = 'www.amazon.co.uk';

// ═══════════════════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node resolve_episode.js <show_url_or_asin> <season> <episode> [--domain amazon.co.uk]');
    process.exit(1);
  }
  const showInput = args[0];
  const season    = parseInt(args[1], 10);
  const episode   = parseInt(args[2], 10);

  let domain = DEFAULT_DOMAIN;
  const di = args.indexOf('--domain');
  if (di !== -1 && args[di + 1]) {
    domain = args[di + 1].replace(/^https?:\/\//, '');
    if (!domain.startsWith('www.')) domain = 'www.' + domain;
  }

  return { showInput, season, episode, domain };
}

function extractAsin(input) {
  const m = input.match(/\/(?:dp|detail|product)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Z0-9]{10}$/i.test(input)) return input.toUpperCase();
  // If it's not a URL or ASIN, assume it's a show name search query
  return null;
}

function extractDomainFromUrl(input) {
  const m = input.match(/https?:\/\/(www\.[^/]+)/);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP — single-purpose, fast, no dependencies
// ═══════════════════════════════════════════════════════════════════════════

function httpGet(url, cookies = '') {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (cookies) headers['Cookie'] = cookies;

    const opts = new URL(url);
    const req = https.get({
      hostname: opts.hostname,
      port: opts.port || 443,
      path: opts.pathname + opts.search,
      headers,
      timeout: 15000,
    }, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        return resolve(httpGet(next, cookies));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 1: Extract from __NEXT_DATA__ JSON blob
// ═══════════════════════════════════════════════════════════════════════════

function tryNextData(html, domain, season, episode) {
  const m = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;

  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }

  // Deep-search for any object with episodeNumber + a titleId/asin/catalogId
  const episodes = [];
  deepSearch(data, episodes);

  // Find matching season + episode
  for (const ep of episodes) {
    if (ep.seasonNumber === season && ep.episodeNumber === episode && ep.asin) {
      return `https://${domain}/gp/video/detail/${ep.asin}/`;
    }
  }

  // If we found episodes but not the right season, find the season ASIN
  // so we can fetch that page
  const seasonAsins = [];
  deepSearchSeasons(data, seasonAsins);
  const targetSeason = seasonAsins.find(s => s.seasonNumber === season);
  if (targetSeason) return { seasonAsin: targetSeason.asin };

  return null;
}

function deepSearch(obj, results, parentSeason = null) {
  if (!obj || typeof obj !== 'object') return;

  // Track season context as we traverse
  let currentSeason = parentSeason;
  if (typeof obj.seasonNumber === 'number') currentSeason = obj.seasonNumber;

  if (typeof obj.episodeNumber === 'number') {
    const asin = obj.titleId || obj.catalogId || obj.asin || obj.id || obj.compactGTI;
    // Only accept 10-char ASINs (external format)
    const cleanAsin = extractCleanAsin(asin);
    if (cleanAsin) {
      results.push({
        episodeNumber: obj.episodeNumber,
        seasonNumber: currentSeason || obj.seasonNumber || 0,
        asin: cleanAsin,
        title: obj.title || '',
      });
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) deepSearch(item, results, currentSeason);
  } else {
    for (const key of Object.keys(obj)) {
      deepSearch(obj[key], results, currentSeason);
    }
  }
}

function deepSearchSeasons(obj, results) {
  if (!obj || typeof obj !== 'object') return;

  if (typeof obj.seasonNumber === 'number' && (obj.type === 'SEASON' || obj.entityType === 'Season')) {
    const asin = extractCleanAsin(obj.titleId || obj.catalogId || obj.asin || obj.id || obj.compactGTI);
    if (asin) {
      results.push({ seasonNumber: obj.seasonNumber, asin });
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) deepSearchSeasons(item, results);
  } else {
    for (const key of Object.keys(obj)) {
      deepSearchSeasons(obj[key], results);
    }
  }
}

function extractCleanAsin(raw) {
  if (!raw) return null;
  if (/^[A-Z0-9]{10}$/i.test(raw)) return raw.toUpperCase();
  // Extract from gti: amzn1.dv.gti.xxx → not useful for URLs
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 2: Extract from embedded <script> state blobs
// ═══════════════════════════════════════════════════════════════════════════

function tryEmbeddedState(html, domain, season, episode) {
  // Amazon sometimes uses window.__PRELOADED_STATE__ or data-a-state
  const patterns = [
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i,
    /window\.__ATVWebPlayerData__\s*=\s*({[\s\S]*?});?\s*<\/script>/i,
    /"props"\s*:\s*({[\s\S]*?})\s*,\s*"page"/i,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]);
      const episodes = [];
      deepSearch(data, episodes);
      for (const ep of episodes) {
        if (ep.seasonNumber === season && ep.episodeNumber === episode && ep.asin) {
          return `https://${domain}/gp/video/detail/${ep.asin}/`;
        }
      }
    } catch { /* try next pattern */ }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 3: CDP API (Out of the box)
// ═══════════════════════════════════════════════════════════════════════════

async function tryCdpSearch(showName, domain) {
  const isEu = /\.(uk|de|fr|it|es)$/i.test(domain);
  const endpoint = isEu ? 'atv-ps-eu.amazon.co.uk' : 'atv-ps.amazon.com';
  const region = isEu ? 'GB' : 'US'; // Rough approximation
  
  const apiUrl = `https://${endpoint}/cdp/catalog/Search?phrase=${encodeURIComponent(showName)}&contentType=TV&pageSize=5&regionCode=${region}&format=json`;
  
  try {
    const res = await fetch(apiUrl, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const data = await res.json();
      if (data?.message?.body?.titles?.[0]?.titleId) {
        return data.message.body.titles[0].titleId;
      }
    }
  } catch (err) {
    // Ignore error and fall back
  }
  return null;
}

async function tryCdpApi(asin, domain, season, episode, cookies) {
  // Use Amazon's internal Content Discovery Platform API
  // This entirely bypasses the frontend UI and HTML layout
  
  // Choose endpoint based on domain
  const isEu = /\.(uk|de|fr|it|es)$/i.test(domain);
  const endpoint = isEu ? 'atv-ps-eu.amazon.co.uk' : 'atv-ps.amazon.com';
  
  const apiUrl = `https://${endpoint}/cdp/catalog/GetCatalogMetadata?titleID=${asin}&seasonNumber=${season}&episodeNumber=${episode}&format=json`;
  
  try {
    const headers = { 'User-Agent': UA };
    if (cookies) headers['Cookie'] = cookies;
    
    // We can use the built-in global fetch (Node 18+)
    const res = await fetch(apiUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data?.message?.body?.titles?.[0]?.titleId) {
        const epAsin = data.message.body.titles[0].titleId;
        return `https://${domain}/dp/${epAsin}`;
      }
    }
  } catch (err) {
    // Silently fail and fallback to other strategies
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const t0 = Date.now();
  const el = () => `${Date.now() - t0}ms`;

  const { showInput, season, episode, domain: cliDomain } = parseArgs();
  const domain = extractDomainFromUrl(showInput) || cliDomain;
  const cookies = process.env.AMAZON_COOKIES || '';

  let asin = extractAsin(showInput);

  // If not a URL or ASIN, try the API search directly
  if (!asin) {
    console.log(`[${el()}] Searching catalog for: "${showInput}"`);
    asin = await tryCdpSearch(showInput, domain);
    if (!asin) {
      console.error(`[${el()}] ❌ Could not find ASIN for search query: ${showInput}`);
      process.exit(1);
    }
  }

  console.log(`[${el()}] Show=${asin}  Season=${season}  Episode=${episode}  Domain=${domain}`);

  // ── Strategy 1: Fast path — Pure API (Zero HTML) ────────────────────────
  let result = await tryCdpApi(asin, domain, season, episode, cookies);
  if (result) {
    console.log(`[${el()}] ✅ Resolved via CDP Catalog API`);
    return output(result, el);
  }

  // ── Fallback: Fetch show page for JSON extraction ───────────────────────
  const showUrl = `https://${domain}/gp/video/detail/${asin}/`;
  console.log(`[${el()}] GET ${showUrl}`);

  const { status, body: html } = await httpGet(showUrl, cookies);
  console.log(`[${el()}] ${status} — ${html.length} bytes`);

  if (status >= 400) {
    console.error(`[${el()}] ❌ HTTP ${status}. Page may require authentication.`);
    console.error('   Set AMAZON_COOKIES env var with your session cookies.');
    process.exit(1);
  }

  // ── Try JSON extraction strategies ───────────────────────────────────────
  // Strategy 2: __NEXT_DATA__ JSON Payload
  result = tryNextData(html, domain, season, episode);
  if (typeof result === 'string') {
    console.log(`[${el()}] ✅ Resolved via __NEXT_DATA__ JSON`);
    return output(result, el);
  }

  // Strategy 3: Embedded state blobs JSON
  result = tryEmbeddedState(html, domain, season, episode);
  if (result) {
    console.log(`[${el()}] ✅ Resolved via embedded state JSON`);
    return output(result, el);
  }

  // ── If strategies failed, try fetching the specific season page ─────────
  // __NEXT_DATA__ might have returned a seasonAsin redirect
  let seasonAsin = (result && typeof result === 'object') ? result.seasonAsin : null;

  if (seasonAsin && seasonAsin !== asin) {
    console.log(`[${el()}] Season ${season} ASIN: ${seasonAsin} — fetching...`);
    const seasonUrl = `https://${domain}/gp/video/detail/${seasonAsin}/`;
    const { body: sHtml } = await httpGet(seasonUrl, cookies);
    console.log(`[${el()}] Season page: ${sHtml.length} bytes`);

    result = tryNextData(sHtml, domain, season, episode);
    if (typeof result === 'string') return output(result, el);

    result = tryEmbeddedState(sHtml, domain, season, episode);
    if (result) return output(result, el);
  }

  // ── All strategies exhausted ────────────────────────────────────────────
  console.error(`\n[${el()}] ❌ Could not resolve episode URL.`);
  console.error('   Possible causes:');
  console.error('   - Show ASIN is incorrect');
  console.error('   - Season/episode does not exist');
  console.error('   - Page requires authentication (set AMAZON_COOKIES env var)');
  console.error('   - Amazon changed their page structure');
  process.exit(1);
}

function output(url, el) {
  console.log(`\n  ┌─────────────────────────────────────────────────`);
  console.log(`  │  Episode URL: ${url}`);
  console.log(`  └─────────────────────────────────────────────────`);
  console.log(`\n[${el()}] Done.`);

  // Also output just the URL to stdout for piping
  // (all other output goes to stderr if needed)
  return url;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROGRAMMATIC API — importable as a module
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve an Amazon Prime Video episode URL.
 * @param {string} showAsin  - 10-char ASIN or full show URL
 * @param {number} season    - Season number (1-based)
 * @param {number} episode   - Episode number (1-based)
 * @param {object} opts      - { domain, cookies }
 * @returns {Promise<string>} Episode URL
 */
async function resolveEpisodeUrl(showAsin, season, episode, opts = {}) {
  const domain  = opts.domain || DEFAULT_DOMAIN;
  const cookies = opts.cookies || '';
  const asin    = /^[A-Z0-9]{10}$/i.test(showAsin)
    ? showAsin.toUpperCase()
    : extractAsin(showAsin);

  // Try API first
  let result = await tryCdpApi(asin, domain, season, episode, cookies);
  if (result) return result;

  // Fallback to HTML JSON
  const showUrl = `https://${domain}/gp/video/detail/${asin}/`;
  const { body: html } = await httpGet(showUrl, cookies);

  result = tryNextData(html, domain, season, episode);
  if (typeof result === 'string') return result;

  result = tryEmbeddedState(html, domain, season, episode);
  if (result) return result;

  // Try season-specific page if found in JSON
  let seasonAsin = (result && typeof result === 'object') ? result.seasonAsin : null;

  if (seasonAsin && seasonAsin !== asin) {
    const { body: sHtml } = await httpGet(`https://${domain}/gp/video/detail/${seasonAsin}/`, cookies);

    result = tryNextData(sHtml, domain, season, episode);
    if (typeof result === 'string') return result;

    result = tryEmbeddedState(sHtml, domain, season, episode);
    if (result) return result;
  }

  throw new Error(`Could not resolve S${season}E${episode} for ASIN ${asin}`);
}

module.exports = { resolveEpisodeUrl };

// ═══════════════════════════════════════════════════════════════════════════
//  RUN
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
