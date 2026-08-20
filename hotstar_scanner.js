#!/usr/bin/env node
'use strict';
const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');
const path = require('path');
const { execSync, spawn } = require('child_process');

// â”€â”€ CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = 'gemini-2.5-flash';
// Fallback chain: when the primary model's free-tier quota is exhausted, try these.
// Each model has its own quota pool.
const GEMINI_FALLBACKS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const CHROME_PATH     = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR     = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const AD_WAIT_MS      = 20000;   // Hotstar pre-roll ads can run up to ~15s
const MANIFEST_POLL_MS = 250;    // poll captured responses for manifest URL (fast)
const SUB_TIMEOUT_MS  = 40000;   // max extra wait for first VTT segment
const GEMINI_TIMEOUT  = 120000;
const HOTSTAR_PROFILE = 'saji';  // Hotstar account profile to auto-select
const PICKER_DETECT_MS = 3000;   // how long to wait for picker signal to appear
const PICKER_CLICK_MS  = 6000;   // how long to retry clicking the matching tile

// â”€â”€ SUBTITLE TEXT CLEANUP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const RE_MUSIC_ONLY     = /^â™ª+\s*â™ª*$/;
const RE_MUSIC_LEAD     = /^â™ª\s*/;
const RE_MUSIC_TRAIL    = /\s*â™ª+$/;
const RE_SPEAKER_BRACKET = /\[([A-Za-z'.]+)\]/;
const RE_SPEAKER_COLON   = /^([A-Z][A-Z\s'.]+):\s/;
const SFX = new Set(
  'laughs,sighs,gasps,groans,scoffs,chuckles,coughs,sniffs,exhales,inhales,crying,screaming,' +
  'grunts,whimpers,sobbing,panting,knocking,doorbell,phone,song,music,indistinct,wind,thunder,' +
  'gunshot,explosion,applause,cheering,laughter,clears,exclaims,whispers,giggles,school,excited,' +
  'whooping,others,loud,both,door,laughing,all,groaning,band,people,engine,sniffling,knock,' +
  'stammers,line,rings,chatter,closes,starts,ringing,warming,bell,softly,weakly,quietly,sharply,' +
  'continues,playing,faintly,vibrating,whooshing,hip,horn,tires,siren,static,beeping,buzzing,' +
  'clicking,ticking,crackling,rustling,squeaking,thudding,clanking,clattering,hammering,dripping,' +
  'splashing,pouring,birds,dogs,crickets,wolves,rain,footsteps'.split(',')
);

const geminiAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// â”€â”€ BROWSER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Chrome 148+ disables --remote-debugging-port AND Chrome 127+ has App-Bound
// Encryption that prevents cloned cookies from decrypting. The workaround: a
// PERSISTENT dedicated profile where you sign into Hotstar once. Subsequent
// runs reuse that authenticated profile.
const PROFILE_PATH = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Google', 'Chrome', 'HotstarScannerProfile');

// Hotstar's webapp sets localStorage["loginState"] = {"value":"LOGGEDIN"} on sign-in,
// and the userUP cookie holds the JWT. Both are reliable, locally-readable signals.
async function isSignedIn(page) {
  try {
    // Primary: localStorage flag set explicitly by Hotstar's webapp
    const loginState = await page.evaluate(() => {
      try { return localStorage.getItem('loginState'); } catch { return null; }
    });
    if (loginState && /LOGGEDIN/i.test(loginState)) return true;

    // Secondary: presence of userUP JWT cookie
    const cookies = await page.cookies('https://www.hotstar.com/');
    return cookies.some(c => c.name === 'userUP' && c.value && c.value.length > 100);
  } catch {
    return false;
  }
}

async function waitForSignin(browser, timeoutMs = 300000) {
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto('https://www.hotstar.com/in', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  console.log('\nâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  console.log('  SIGN IN TO HOTSTAR in the Chrome window that just opened.');
  console.log('  The script polls every 2s and continues automatically once detected.');
  console.log('  This is ONE-TIME â€” the profile is persistent at:');
  console.log(`    ${PROFILE_PATH}`);
  console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');

  const deadline = Date.now() + timeoutMs;
  let lastTick = Date.now();
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) {
      console.log('[INIT] Sign-in detected â€” continuing.');
      return;
    }
    if (Date.now() - lastTick > 15000) {
      console.log('[INIT] Still waiting for sign-in...');
      lastTick = Date.now();
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Sign-in timed out after 5 minutes');
}

// Patch Chrome's Preferences file so it doesn't try to restore tabs from a previous
// session (force-kill marks exit_type as Crashed, which triggers the restore prompt).
function clearChromeSessionState() {
  const defaultDir = path.join(PROFILE_PATH, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');
  if (fs.existsSync(prefsPath)) {
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      prefs.profile = prefs.profile || {};
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      // Clear startup URLs and session restore
      prefs.session = prefs.session || {};
      prefs.session.restore_on_startup = 5; // 5 = open new tab page
      delete prefs.session.startup_urls;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch {}
  }
  // Delete session/tab restore files
  for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try { fs.unlinkSync(path.join(defaultDir, f)); } catch {}
  }
  // Singleton locks left from force-kill
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE_PATH, f)); } catch {}
  }
}

async function launchBrowser() {
  console.log('[INIT] Closing any running Chrome instances...');
  try { execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 800));

  if (!fs.existsSync(PROFILE_PATH)) fs.mkdirSync(PROFILE_PATH, { recursive: true });
  clearChromeSessionState();
  console.log(`[INIT] Launching Chrome from persistent profile: ${PROFILE_PATH}`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_PATH,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run', '--no-default-browser-check',
      '--restore-last-session=false',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-features=InfiniteSessionRestore,Translate,OptimizationHints',
      '--disable-prompt-on-repost',
      '--metrics-recording-only',
      '--disable-component-extensions-with-background-pages',
    ],
  });

  // Close any extra tabs Chrome opened (restored tabs from previous session, "What's new", etc.)
  const pages = await browser.pages();
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }
  if (pages.length > 1) console.log(`[INIT] Closed ${pages.length - 1} extra tab(s)`);

  // Verify sign-in; prompt user if not authenticated yet
  const probe = (await browser.pages())[0] || await browser.newPage();
  await probe.goto('https://www.hotstar.com/in', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!(await isSignedIn(probe))) {
    await waitForSignin(browser);
  } else {
    console.log('[INIT] Already signed in.');
  }

  // After sign-in, Hotstar sometimes shows a profile picker â€” pick the configured one
  await selectProfileIfPrompted(probe, HOTSTAR_PROFILE);

  console.log('[INIT] Browser ready.');
  return browser;
}

// Hotstar's profile picker. Detection is STRICT (text or URL signals only) so
// it doesn't false-positive on home pages where DOM classes match. We poll up
// to 8s for those signals to appear (React hydration is slow), then try to
// click for up to 8s. Returns true if click succeeded.
// Session-level flag â€” once we've selected a profile, subsequent navigations
// rarely re-prompt. A quick one-shot check is enough on those.
let _profileSelectedThisSession = false;

async function selectProfileIfPrompted(page, profileName) {
  // Fast path: if we already clicked once, do a single non-polling check
  if (_profileSelectedThisSession) {
    try {
      const visible = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        return /who'?s watching|select.*profile/i.test(bodyText) ||
               /profile-selection|select-profile/i.test(location.pathname.toLowerCase());
      });
      if (!visible) return false;
    } catch { return false; }
  }

  const start = Date.now();
  let pickerConfirmed = false;

  // Phase 1: confirm the picker is actually visible (text or URL signal)
  // Short timeout â€” if picker doesn't appear within PICKER_DETECT_MS, it's not shown
  while (Date.now() - start < PICKER_DETECT_MS) {
    try {
      const sigs = await page.evaluate(() => {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const url = location.pathname.toLowerCase();
        return {
          text: /who'?s watching|choose.*profile|select.*profile/i.test(bodyText),
          url: /profile-selection|select-profile|whoswatching|switch-profile/i.test(url),
        };
      });
      if (sigs.text || sigs.url) { pickerConfirmed = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }

  if (!pickerConfirmed) return false;
  console.log(`[INIT] Profile picker confirmed â€” clicking "${profileName}"...`);

  // Phase 2: try to click the matching profile tile (multiple strategies, retry up to 8s)
  const clickStart = Date.now();
  while (Date.now() - clickStart < PICKER_CLICK_MS) {
    try {
      const clicked = await page.evaluate((name) => {
        const target = name.toLowerCase();
        const tryClick = (el) => {
          let cur = el;
          while (cur && cur !== document.body) {
            const style = window.getComputedStyle(cur);
            const tag = cur.tagName?.toLowerCase();
            if (tag === 'a' || tag === 'button' ||
                cur.getAttribute?.('role') === 'button' ||
                cur.onclick || style.cursor === 'pointer') {
              cur.click();
              return cur.tagName;
            }
            cur = cur.parentElement;
          }
          el.click();
          return el.tagName;
        };
        // Strategy 1: image with matching alt
        for (const img of document.querySelectorAll('img')) {
          const alt = (img.alt || '').toLowerCase();
          if (alt === target || (alt.length > 0 && alt.length < 30 && alt.includes(target))) {
            return 'IMG-alt[' + alt + ']:' + tryClick(img);
          }
        }
        // Strategy 2: interactive with exact text
        for (const el of document.querySelectorAll('button, a, [role="button"], [tabindex]:not([tabindex="-1"])')) {
          const txt = (el.textContent || '').trim().toLowerCase();
          if (txt === target) return 'INTERACT[' + txt + ']:' + tryClick(el);
        }
        // Strategy 3: short-text element
        for (const el of document.querySelectorAll('div, span, li, p, h1, h2, h3')) {
          const txt = (el.textContent || '').trim().toLowerCase();
          if (txt.length > 0 && txt.length < 30 && (txt === target || txt.includes(target))) {
            return 'TEXT[' + txt + ']:' + tryClick(el);
          }
        }
        return null;
      }, profileName);

      if (clicked) {
        console.log(`[INIT] Picker â†’ clicked ${clicked}`);
        _profileSelectedThisSession = true;
        await new Promise(r => setTimeout(r, 3500));
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  // Confirmed picker but couldn't click â€” save screenshot
  try {
    const shot = path.join(process.cwd(), `profile_picker_debug_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[INIT] Picker confirmed but couldn't click "${profileName}" â€” screenshot: ${shot}`);
  } catch {}
  return false;
}

// â”€â”€ STEP 1: RESOLVE EPISODE URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Strategy:
//   1. Load show page â†’ passively capture ALL JSON responses (no filtering)
//   2. Search captures with flexible matchers (multiple field names, nested patterns)
//   3. If episode not found in initial load â†’ click season selector, scroll
//   4. Fallback to DOM extraction (parse rendered episode anchors)
//   5. On failure â†’ dump all captured responses to disk for debugging

const RE_SE_TAG = /S(?:eason\s*)?(\d+)\s*(?:[EÂ·\-â€¢|x]|Ep(?:isode)?)\s*(\d+)/i;

// Try every common location for season/episode info on a data object
function detectSeasonEpisode(data) {
  if (!data || typeof data !== 'object') return null;

  // Direct numeric fields
  const sFields = ['seasonNo', 'season_no', 'seasonNumber', 'season_number', 'season'];
  const eFields = ['episodeNo', 'episode_no', 'episodeNumber', 'episode_number', 'episode', 'episodeNum'];
  let s = null, e = null;
  for (const k of sFields) if (typeof data[k] === 'number') { s = data[k]; break; }
  for (const k of eFields) if (typeof data[k] === 'number') { e = data[k]; break; }
  if (s !== null && e !== null) return { s, e };

  // Tag arrays â€” each tag may be a string or {value/text/label/title}
  const tagFields = ['tags', 'badges', 'labels', 'meta_tags', 'metadata'];
  for (const tf of tagFields) {
    if (!Array.isArray(data[tf])) continue;
    for (const tag of data[tf]) {
      const v = typeof tag === 'string' ? tag : (tag?.value || tag?.text || tag?.label || tag?.title || '');
      const m = v.match(RE_SE_TAG);
      if (m) return { s: +m[1], e: +m[2] };
    }
  }

  // Description / subtitle / tagline
  for (const k of ['description', 'subtitle', 'tagline', 'meta', 'shortDescription', 'short_title']) {
    if (typeof data[k] === 'string') {
      const m = data[k].match(RE_SE_TAG);
      if (m) return { s: +m[1], e: +m[2] };
    }
  }

  return null;
}

// Pull a playable URL out of an episode-like data object
function detectEpisodeUrl(data) {
  if (!data || typeof data !== 'object') return null;

  // Hotstar's BFF pattern: actions.on_click â†’ page_navigation â†’ page_slug
  const onClicks = data.actions?.on_click;
  if (Array.isArray(onClicks)) {
    for (const a of onClicks) {
      const slug = a?.page_navigation?.page_slug || a?.pageNavigation?.pageSlug;
      if (slug) return slug.startsWith('http') ? slug : `https://www.hotstar.com${slug}`;
    }
  }

  // Direct slug / URL fields
  const direct =
    data.page_slug || data.pageSlug || data.slug ||
    data.watch_url || data.watchUrl || data.url || data.uri ||
    data.target?.page_slug || data.target?.url;
  if (direct) return direct.startsWith('http') ? direct : `https://www.hotstar.com${direct}`;

  return null;
}

// Recursively scan any JSON for an episode matching season/episode
function findEpisodeInJson(obj, targetS, targetE, seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);

  // Drill into known wrappers AND the object itself
  const candidates = [obj, obj.playable_content?.data, obj.content?.data, obj.data, obj.episode, obj.content];
  for (const d of candidates) {
    if (!d || typeof d !== 'object') continue;
    const id = d.content_id || d.contentId || d.id;
    const title = d.title || d.name;
    if (!id || !title) continue;
    const se = detectSeasonEpisode(d);
    if (!se || se.s !== targetS || se.e !== targetE) continue;
    const url = detectEpisodeUrl(d);
    if (!url) continue;
    return { contentId: String(id), title, url };
  }

  // Recurse
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const f = findEpisodeInJson(item, targetS, targetE, seen);
      if (f) return f;
    }
  } else {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const f = findEpisodeInJson(v, targetS, targetE, seen);
        if (f) return f;
      }
    }
  }
  return null;
}

function searchCaptures(captures, targetS, targetE) {
  for (const c of captures) {
    if (!c.json) {
      try { c.json = JSON.parse(c.text); } catch { c.json = false; continue; }
    }
    if (!c.json) continue;
    const found = findEpisodeInJson(c.json, targetS, targetE);
    if (found) return found;
  }
  return null;
}

// Click any element whose text matches "Season N"
async function clickSeasonSelector(page, season) {
  return page.evaluate((s) => {
    const variants = [`Season ${s}`, `S${s}`, `Season-${s}`, `Season${s}`, `SEASON ${s}`];
    const all = document.querySelectorAll('button, a, [role="button"], [role="tab"], li, div, span');
    for (const el of all) {
      const txt = (el.textContent || '').trim();
      if (variants.some(v => txt === v || txt.toLowerCase() === v.toLowerCase())) {
        el.click();
        return txt;
      }
    }
    return null;
  }, season);
}

// Last-resort: parse rendered DOM for episode anchors
async function extractEpisodeFromDOM(page, season, episode) {
  return page.evaluate((s, e) => {
    const seRe = new RegExp(`S(?:eason\\s*)?${s}\\s*(?:[EÂ·\\-â€¢|x]|Ep(?:isode)?)\\s*${e}\\b`, 'i');
    const anchors = document.querySelectorAll('a[href*="/watch"]');
    for (const a of anchors) {
      const container = a.closest('article, [class*="episode"], [class*="card"], [class*="tile"], li, div') || a;
      const text = (container.textContent || '').trim();
      if (!seRe.test(text)) continue;
      const titleEl = container.querySelector('h1, h2, h3, h4, [class*="title"], [class*="name"]');
      const title = (titleEl?.textContent || a.textContent || '').trim() || `S${s}E${e}`;
      const m = a.href.match(/\/(\d+)\/watch/);
      return { contentId: m ? m[1] : '', title, url: a.href };
    }
    return null;
  }, season, episode);
}

function dumpDebug(captures, label) {
  const file = path.join(process.cwd(), `hotstar_debug_${label}_${Date.now()}.txt`);
  const lines = [`=== Looking for ${label} â€” ${captures.length} JSON responses captured ===`, ''];
  captures.forEach((c, i) => {
    lines.push(`--- [${i + 1}/${captures.length}] ${c.url}`);
    lines.push(`Length: ${c.text.length}`);
    lines.push(`Preview: ${c.text.substring(0, 1500)}`);
    lines.push('');
  });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

async function resolveEpisodeUrl(browser, showUrl, season, episode) {
  const label = `S${season}E${episode}`;
  const t0 = Date.now();
  console.log(`[RESOLVE] ${label} from ${showUrl}`);

  const page = await browser.newPage();
  const captures = [];

  // Block heavy resources â€” show pages load lots of thumbnails we never use.
  // We only need scripts + JSON XHR to extract episode URLs from BFF responses.
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return req.abort();
    if (/\.(jpg|jpeg|png|webp|gif|svg|woff|woff2|ttf|otf|mp4|m4s|ts)(\?|$)/i.test(url)) return req.abort();
    if (/google-analytics|googletagmanager|mixpanel|doubleclick|moengage/.test(url)) return req.abort();
    req.continue();
  });

  // Capture every JSON response â€” no filtering, we'll search them all
  const onResp = async (resp) => {
    try {
      if (resp.request().method() === 'OPTIONS') return;
      const ct = resp.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const text = await resp.text();
      if (text.length < 50) return;
      captures.push({ url: resp.url(), text, json: null });
    } catch {}
  };
  page.on('response', onResp);

  await page.goto(showUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  // Auto-dismiss profile picker if it appears after navigation
  const clickedProfile = await selectProfileIfPrompted(page, HOTSTAR_PROFILE);
  if (clickedProfile) {
    // Re-navigate to the show URL â€” Hotstar may redirect to /home after profile click
    captures.length = 0; // discard responses from the picker page
    console.log('[RESOLVE] Re-navigating to show URL after profile selection...');
    await page.goto(showUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  // Poll for episode as captures arrive (fast â€” 100ms interval)
  const waitForEpisode = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = searchCaptures(captures, season, episode);
      if (found) return found;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  };

  let result = await waitForEpisode(4000);

  // Try season selector
  if (!result) {
    const clicked = await clickSeasonSelector(page, season);
    if (clicked) {
      console.log(`[RESOLVE] Clicked "${clicked}" â€” waiting for season API call...`);
      result = await waitForEpisode(3500);
    }
  }

  // Try scrolling to trigger lazy loads (both window and horizontal carousels)
  if (!result) {
    console.log('[RESOLVE] Scrolling to trigger lazy loads...');
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      document.querySelectorAll('[class*="scroll"], [class*="carousel"], [class*="row"], [class*="tray"]').forEach(el => {
        el.scrollLeft = el.scrollWidth;
        el.scrollTop = el.scrollHeight;
      });
    }).catch(() => {});
    result = await waitForEpisode(2500);
  }

  // DOM fallback
  if (!result) {
    console.log('[RESOLVE] Trying DOM extraction...');
    result = await extractEpisodeFromDOM(page, season, episode);
  }

  page.off('response', onResp);
  await page.close().catch(() => {});

  if (!result) {
    const debugFile = dumpDebug(captures, label);
    throw new Error(`${label} not found. Dumped ${captures.length} JSON responses to ${debugFile} â€” open it to see what Hotstar's API actually returned.`);
  }

  console.log(`[RESOLVE] âœ“ "${result.title}" â†’ ${result.url} (${Date.now() - t0}ms)`);
  return result;
}

// â”€â”€ STEP 2: CAPTURE SUBTITLES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Navigates to episode page, waits for ads, then either:
//   a) pro-actively fetches all segments via an intercepted playlist URL, or
//   b) falls back to passively captured VTT responses from the response listener.

function extractM3u8SubtitleUrl(text, manifestUrl) {
  const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  let uri = null;
  // Prefer LANGUAGE="en*"
  for (const line of text.split('\n')) {
    if (!line.includes('TYPE=SUBTITLES')) continue;
    if (/LANGUAGE="en(?:-\w+)?"/i.test(line)) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) { uri = m[1]; break; }
    }
  }
  // Fall back to first subtitle track
  if (!uri) {
    for (const line of text.split('\n')) {
      if (!line.includes('TYPE=SUBTITLES')) continue;
      const m = line.match(/URI="([^"]+)"/);
      if (m) { uri = m[1]; break; }
    }
  }
  // URL heuristics
  if (!uri) {
    const m = text.match(/URI="([^"]*(?:sbtl|sub)[^"]*\.m3u8[^"]*)"/i);
    if (m) uri = m[1];
  }
  return uri ? (uri.startsWith('http') ? uri : base + uri) : null;
}

// Proper MPD subtitle URL resolution. Walks the BaseURL chain (Period â†’
// AdaptationSet â†’ Representation) using `new URL()` to handle relative paths
// and `..` segments correctly. Carries the manifest's query string (hmac auth)
// onto the subtitle URL so CDN auth passes.
function extractMpdSubtitleUrl(text, manifestUrl) {
  // Strip query string for base, but remember it to re-append (hmac auth)
  const manifestQuery = manifestUrl.includes('?') ? manifestUrl.substring(manifestUrl.indexOf('?')) : '';
  const manifestBase = manifestUrl.split('?')[0];

  // Period-level BaseURL (applies to all AdaptationSets in the period)
  const periodMatch = text.match(/<Period[^>]*>\s*<BaseURL>([^<]+)<\/BaseURL>/i);
  const periodBase = periodMatch ? periodMatch[1].trim() : null;

  // Find ALL AdaptationSets, prefer English text/vtt
  const adaptRegex = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
  const candidates = []; // { attrs, body, isEn }
  let m;
  while ((m = adaptRegex.exec(text)) !== null) {
    const attrs = m[1], body = m[2];
    const isSubtitle =
      /contentType="text"/i.test(attrs) ||
      /mimeType="text\/vtt"/i.test(attrs) ||
      /mimeType="text\/vtt"/i.test(body) ||
      /Role[^>]*value="subtitle"/i.test(body);
    if (!isSubtitle) continue;
    const isEn = /lang="en/i.test(attrs);
    candidates.push({ attrs, body, isEn });
  }
  if (!candidates.length) return null;
  const chosen = candidates.find(c => c.isEn) || candidates[0];

  // AdaptationSet-level BaseURL (rare but possible)
  // Match a BaseURL that's a direct child of AdaptationSet (not inside Representation)
  const adapBaseMatch = chosen.body.match(/^\s*(?:<Role[^/]*\/>\s*)*<BaseURL>([^<]+)<\/BaseURL>/i);
  const adapBase = adapBaseMatch ? adapBaseMatch[1].trim() : null;

  // Representation-level BaseURL (the actual subtitle file)
  const reprMatch = chosen.body.match(/<Representation[^>]*>([\s\S]*?)<\/Representation>/i);
  const reprBody = reprMatch ? reprMatch[1] : chosen.body;
  const reprBaseMatch = reprBody.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
  const reprBase = reprBaseMatch ? reprBaseMatch[1].trim() : null;
  if (!reprBase) return null;

  // Resolve URLs progressively. `new URL(rel, base)` handles relative paths
  // and `..` correctly, and works whether `rel` is absolute or relative.
  let resolved = manifestBase;
  if (periodBase) resolved = new URL(periodBase, resolved).href;
  if (adapBase) resolved = new URL(adapBase, resolved).href;
  resolved = new URL(reprBase, resolved).href;

  // Carry the manifest's hmac auth query string so CDN auth passes
  if (manifestQuery && !resolved.includes('?')) resolved += manifestQuery;
  return resolved;
}

async function fetchAllPlaylistSegments(page, playlistUrl) {
  const segments = [];
  try {
    const playlist = await page.evaluate(async u => (await fetch(u)).text(), playlistUrl);
    const base = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
    const segUrls = playlist.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    console.log(`[VTT] Playlist has ${segUrls.length} segments â€” fetching all...`);
    for (const seg of segUrls) {
      const url = seg.startsWith('http') ? seg : base + seg;
      try {
        const vtt = await page.evaluate(async u => (await fetch(u)).text(), url);
        if (vtt.includes('-->')) segments.push(vtt);
      } catch {}
    }
  } catch (e) {
    console.log(`[VTT] Playlist fetch failed: ${e.message}`);
  }
  return segments;
}

// Recursively find any string that looks like a manifest or subtitle URL
function findUrlInJson(obj, predicate, seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const v of obj) {
      if (typeof v === 'string' && predicate(v)) return v;
      if (v && typeof v === 'object') { const f = findUrlInJson(v, predicate, seen); if (f) return f; }
    }
  } else {
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && predicate(v)) return v;
      if (v && typeof v === 'object') { const f = findUrlInJson(v, predicate, seen); if (f) return f; }
    }
  }
  return null;
}

async function captureSubtitles(browser, episodeUrl) {
  const page = await browser.newPage();

  // Block heavy resources we never use â€” saves bandwidth/CPU on Hotstar's heavy player page.
  // We KEEP: documents, scripts, JSON XHR, manifests, the subtitle .vtt itself.
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const type = req.resourceType();
    if (type === 'image' || type === 'font' || type === 'media') return req.abort();
    if (/\.(jpg|jpeg|png|webp|gif|svg|woff|woff2|ttf|otf|m4s|m4a|ts|dash)(\?|$)/i.test(url)) {
      // Allow .vtt and .mpd through
      if (!/\.(vtt|mpd|m3u8)(\?|$)/i.test(url)) return req.abort();
    }
    // Block ad/analytics noise
    if (/hesads\.akamaized|google-analytics|googletagmanager|mixpanel|doubleclick|moengage/.test(url)) return req.abort();
    req.continue();
  });

  const apiResponses = []; // collected JSON responses
  const vttSegments = [];
  let manifestUrl = null;
  let subtitlePlaylistUrl = null;
  let manifestText = null;       // raw fetched manifest content (for debug on failure)
  let manifestFetched = false;
  let subtitleFetchAttempted = false;
  let subtitleFetchBody = null;  // body of failed direct subtitle fetch
  let haveVtt = false;           // set after we have at least one valid VTT segment

  const onResp = async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';

    // Collect JSON responses â€” Hotstar's BFF/playback APIs return manifest URL in JSON
    if (ct.includes('json')) {
      try {
        const text = await response.text();
        if (text.length > 50 && (text.includes('.m3u8') || text.includes('.mpd') || text.includes('playback'))) {
          apiResponses.push({ url, text });
        }
      } catch {}
    }

    // Direct manifest interception (in case the page fetches it without our help)
    if ((url.includes('.mpd') || url.includes('.m3u8')) && !url.includes('hesads')) {
      try {
        const text = await response.text();
        if (!subtitlePlaylistUrl && url.includes('.mpd') && (text.includes('subtitle') || text.includes('text/vtt'))) {
          const found = extractMpdSubtitleUrl(text, url);
          if (found) { subtitlePlaylistUrl = found; manifestUrl = url; console.log(`[VTT] MPD subtitle: ${found.substring(0, 80)}`); }
        }
        if (!subtitlePlaylistUrl && url.includes('.m3u8') && text.includes('SUBTITLES')) {
          const found = extractM3u8SubtitleUrl(text, url);
          if (found) { subtitlePlaylistUrl = found; manifestUrl = url; console.log(`[VTT] M3U8 subtitle: ${found.substring(0, 80)}`); }
        }
      } catch {}
    }

    // Passive VTT capture â€” skip once we have the direct fetch (avoids dup)
    if (!haveVtt && (url.includes('.vtt') || ct.includes('text/vtt'))) {
      try {
        const text = await response.text();
        if (text.includes('-->') && text.length > 50) {
          vttSegments.push(text);
          haveVtt = true;
          console.log(`[VTT] Captured segment #${vttSegments.length} (${text.length} bytes)`);
        }
      } catch {}
    }
  };

  page.on('response', onResp);
  console.log(`[VTT] Navigating to episode page...`);
  await page.goto(episodeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  // Auto-dismiss profile picker if it appears
  const pickerClicked = await selectProfileIfPrompted(page, HOTSTAR_PROFILE);
  if (pickerClicked) {
    apiResponses.length = 0;
    console.log('[VTT] Re-navigating to episode after profile selection...');
    await page.goto(episodeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  // â”€â”€ Unified capture loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Keeps scanning captured JSON responses for a manifest URL throughout the
  // entire window (not just the ad-wait), and once found, fetches the subtitle.
  // Exits as soon as we have segments.
  const scanForManifest = () => {
    for (const r of apiResponses) {
      if (r.scanned) continue;
      r.scanned = true;
      let j;
      try { j = JSON.parse(r.text); } catch { continue; }
      const url = findUrlInJson(j, s => /\.(m3u8|mpd)(\?|$)/.test(s) && !s.includes('hesads'));
      if (url) {
        console.log(`[VTT] Manifest in ${r.url.substring(0, 80)}`);
        console.log(`        â†’ ${url}`);
        return url;
      }
    }
    return null;
  };

  const totalWindow = AD_WAIT_MS + SUB_TIMEOUT_MS;
  const captureDeadline = Date.now() + totalWindow;
  console.log(`[VTT] Polling for manifest + subtitle (window: ${totalWindow / 1000}s)...`);
  let triedBff = false;

  while (Date.now() < captureDeadline && vttSegments.length === 0) {
    // 1. Look for manifest URL in newly captured JSON responses
    if (!manifestUrl) manifestUrl = scanForManifest();

    // 2. After half the window has elapsed without a manifest, try BFF API directly
    if (!manifestUrl && !triedBff && Date.now() > captureDeadline - SUB_TIMEOUT_MS) {
      triedBff = true;
      console.log('[VTT] No manifest seen yet â€” trying Hotstar BFF API directly...');
      const slug = new URL(episodeUrl).pathname;
      const bffCandidates = [
        `https://www.hotstar.com/api/internal/bff/v2/slugs${slug}`,
        `https://www.hotstar.com/api/internal/bff/v2/pages/watch?path=${encodeURIComponent(slug)}`,
      ];
      for (const apiUrl of bffCandidates) {
        try {
          const json = await page.evaluate(async (u) => {
            const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
            if (!r.ok) return null;
            return r.text();
          }, apiUrl);
          if (!json) continue;
          let parsed; try { parsed = JSON.parse(json); } catch { continue; }
          const url = findUrlInJson(parsed, s => /\.(m3u8|mpd)(\?|$)/.test(s) && !s.includes('hesads'));
          if (url) { manifestUrl = url; console.log(`[VTT] Manifest via BFF: ${url.substring(0, 80)}`); break; }
        } catch {}
      }
    }

    // 3. If we have a manifest but no subtitle URL yet, parse the manifest
    if (manifestUrl && !subtitlePlaylistUrl && !manifestFetched) {
      manifestFetched = true;
      try {
        manifestText = await page.evaluate(async u => (await fetch(u)).text(), manifestUrl);
        if (manifestUrl.includes('.mpd')) subtitlePlaylistUrl = extractMpdSubtitleUrl(manifestText, manifestUrl);
        else if (manifestUrl.includes('.m3u8')) subtitlePlaylistUrl = extractM3u8SubtitleUrl(manifestText, manifestUrl);
        if (subtitlePlaylistUrl) console.log(`[VTT] Subtitle URL: ${subtitlePlaylistUrl}`);
        else console.log(`[VTT] Manifest parsed but no English subtitle track found (will save MPD to debug)`);
      } catch (e) { console.log(`[VTT] Manifest fetch error: ${e.message}`); }
    }

    // 4. If we have a subtitle URL, fetch all segments
    if (subtitlePlaylistUrl && vttSegments.length === 0 && !subtitleFetchAttempted) {
      subtitleFetchAttempted = true;
      if (subtitlePlaylistUrl.includes('.m3u8')) {
        const segs = await fetchAllPlaylistSegments(page, subtitlePlaylistUrl);
        if (segs.length) { vttSegments.push(...segs); haveVtt = true; }
      } else {
        try {
          const result = await page.evaluate(async u => {
            const r = await fetch(u);
            return { status: r.status, ct: r.headers.get('content-type'), text: await r.text() };
          }, subtitlePlaylistUrl);
          console.log(`[VTT] Direct fetch â†’ HTTP ${result.status} (${result.ct}, ${result.text.length} bytes)`);
          if (result.text.includes('-->')) {
            vttSegments.push(result.text);
            haveVtt = true;
            console.log(`[VTT] Got VTT directly (${result.text.length} bytes)`);
          } else {
            subtitleFetchBody = result.text; // save for debug
          }
        } catch (e) { console.log(`[VTT] Direct fetch failed: ${e.message}`); }
      }
      if (vttSegments.length > 0) break;
    }

    await new Promise(r => setTimeout(r, MANIFEST_POLL_MS));
  }

  page.off('response', onResp);
  await page.close().catch(() => {});

  // On failure, save EVERYTHING we touched for debugging
  if (vttSegments.length === 0) {
    const ts = Date.now();
    const debugFile = path.join(process.cwd(), `vtt_debug_${ts}.txt`);
    const lines = [];
    lines.push(`=== CAPTURE FAILED ===`);
    lines.push(`Manifest URL found: ${manifestUrl || '(none)'}`);
    lines.push(`Subtitle URL extracted: ${subtitlePlaylistUrl || '(none)'}`);
    lines.push(`JSON responses captured: ${apiResponses.length}`);
    lines.push('');
    if (manifestText) {
      // Save full manifest to a separate file
      const mpdFile = path.join(process.cwd(), `manifest_${ts}.xml`);
      fs.writeFileSync(mpdFile, manifestText);
      console.log(`[VTT] Saved full manifest to ${mpdFile}`);
      lines.push(`=== RAW MANIFEST: ${manifestText.length} bytes, saved to ${mpdFile} ===`);
      // Also include just the subtitle-related parts in main debug
      const subSections = manifestText.match(/<AdaptationSet[^>]*(?:text|subtitle|sbtl|vtt)[\s\S]*?<\/AdaptationSet>/gi);
      if (subSections) {
        lines.push('Subtitle-related AdaptationSets found:');
        subSections.forEach((s, i) => { lines.push(`--- subtitle section ${i + 1} ---`); lines.push(s); });
      } else {
        lines.push('NO subtitle-related AdaptationSet found in manifest!');
      }
      lines.push('');
    }
    if (subtitleFetchBody) {
      lines.push('=== FAILED SUBTITLE FETCH BODY (first 2000 bytes) ===');
      lines.push(subtitleFetchBody.substring(0, 2000));
      lines.push('');
    }
    apiResponses.forEach((r, i) => {
      lines.push(`--- JSON RESPONSE [${i + 1}] ${r.url}`);
      lines.push(r.text.substring(0, 2000));
      lines.push('');
    });
    fs.writeFileSync(debugFile, lines.join('\n'));
    console.log(`[VTT] Debug saved to ${debugFile}`);
    return null;
  }
  return joinVttSegments(vttSegments);
}

function joinVttSegments(segments) {
  // Dedupe: when the player passively fetches the subtitle that we also fetched
  // directly, we'd otherwise concatenate the same content twice. Hash each
  // segment's content (size + first/last cue) and skip exact duplicates.
  const seen = new Set();
  const unique = [];
  for (const seg of segments) {
    // Use first 200 chars + last 200 chars + length as a content fingerprint
    const key = `${seg.length}:${seg.substring(0, 200)}:${seg.substring(Math.max(0, seg.length - 200))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(seg);
  }
  const dropped = segments.length - unique.length;
  if (dropped > 0) console.log(`[VTT] Dropped ${dropped} duplicate segment(s)`);

  let out = unique[0] + '\n';
  for (let i = 1; i < unique.length; i++) {
    const clean = unique[i].split('\n')
      .filter(l => !l.startsWith('WEBVTT') && !l.startsWith('X-TIMESTAMP-MAP') && !l.startsWith('NOTE'))
      .join('\n');
    out += clean + '\n';
  }
  console.log(`[VTT] ${unique.length} unique segment(s), ${out.length} bytes total`);
  return out;
}

// â”€â”€ STEP 3: PARSE VTT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseAndCleanVtt(vtt) {
  const lines = [];
  const chars = new Set();
  const blocks = vtt.split(/\n\s*\n/);
  let lastSpeaker = '', lastTime = '';

  for (const block of blocks) {
    if (!block.trim() || block.startsWith('WEBVTT') || block.startsWith('NOTE')) continue;
    const bLines   = block.split('\n');
    const timeLine = bLines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const tsMatch = timeLine.match(/(\d{2}:\d{2}:\d{2})/);
    const ts      = tsMatch ? tsMatch[1].replace(/^00:/, '') : '00:00';
    const textLines = bLines.slice(bLines.indexOf(timeLine) + 1);
    let t = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
    if (!t || RE_MUSIC_ONLY.test(t)) continue;
    t = t.replace(RE_MUSIC_LEAD, '').replace(RE_MUSIC_TRAIL, '').trim();
    if (!t) continue;

    const br = t.match(RE_SPEAKER_BRACKET);
    if (br && !SFX.has(br[1].toLowerCase())) chars.add(br[1]);
    const co = t.match(RE_SPEAKER_COLON);
    if (co) chars.add(co[1].trim());

    const speaker = co ? co[1].trim() : (br ? br[1] : '');
    if (speaker && speaker === lastSpeaker && lines.length > 0) {
      const ci = lines[lines.length - 1].indexOf('] ');
      if (ci > 0) {
        const prev = lines[lines.length - 1].substring(ci + 2);
        const nw   = co ? t.substring(co[0].length) : (br ? t.replace(RE_SPEAKER_BRACKET, '').trim() : t);
        lines[lines.length - 1] = `[${lastTime}] ${prev} ${nw}`;
        continue;
      }
    }
    lastSpeaker = speaker;
    lastTime    = ts;
    lines.push(`[${ts}] ${t}`);
  }
  return { transcript: lines.join('\n'), lineCount: lines.length, characters: [...chars] };
}

// â”€â”€ STEP 4: GEMINI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _geminiCall(transcript, characters, label, model = GEMINI_MODEL) {
  const prompt =
    `You are a forensic analyst. Analyze this TV transcript and identify EVERY character death â€” on-screen, referenced, or implied.\n\n` +
    `Rules:\n` +
    `- "on_screen" = character dies during THIS episode\n` +
    `- "referenced" = death happened before this episode but is mentioned/discussed\n` +
    `- "implied" = strong contextual evidence suggests death but not explicitly confirmed\n` +
    `- Death indicators: dead/died/killed/murdered/passed away/funeral, gunshots+silence, ` +
    `"we lost her/gone forever", "took care of it/won't be coming back", cancer/terminal, character vanishes after violence\n` +
    `- IGNORE figurative speech ("you're killing me", "I could die of embarrassment")\n` +
    `- Confidence: "high" (explicit), "medium" (strongly implied), "low" (ambiguous)\n\n` +
    `Characters detected: ${characters.join(', ')}\n\nTranscript:\n${transcript}\n\nRespond with valid JSON matching this exact structure.`;

  const schema = {
    type: 'OBJECT',
    properties: {
      episode_summary: { type: 'STRING' },
      deaths: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            character:      { type: 'STRING' },
            type:           { type: 'STRING', enum: ['on_screen', 'referenced', 'implied'] },
            confidence:     { type: 'STRING', enum: ['high', 'medium', 'low'] },
            timestamp:      { type: 'STRING' },
            cause_of_death: { type: 'STRING' },
            evidence:       { type: 'STRING' },
          },
          required: ['character', 'type', 'confidence', 'cause_of_death', 'evidence'],
        },
      },
      total_deaths_on_screen:   { type: 'INTEGER' },
      total_deaths_referenced:  { type: 'INTEGER' },
      characters_at_risk: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { character: { type: 'STRING' }, reason: { type: 'STRING' } },
          required: ['character', 'reason'],
        },
      },
    },
    required: ['episode_summary', 'deaths', 'total_deaths_on_screen', 'total_deaths_referenced'],
  };

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json', responseSchema: schema },
    });
    const buf = Buffer.from(payload);
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
        agent: geminiAgent,
        timeout: GEMINI_TIMEOUT,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            const j = JSON.parse(body);
            if (j.error) return reject(new Error(j.error.message));
            const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!txt) return reject(new Error(`Empty Gemini response for ${label}`));
            try {
              resolve(JSON.parse(txt));
            } catch {
              try {
                resolve(JSON.parse(
                  txt.replace(/^```json\s*/i, '').replace(/\s*```$/, '').replace(/,\s*([}\]])/g, '$1')
                ));
              } catch (e2) {
                reject(new Error(`JSON parse failed: ${e2.message}`));
              }
            }
          } catch (e) {
            reject(new Error(`API parse failed: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Gemini timeout for ${label}`)); });
    req.write(buf);
    req.end();
  });
}

async function analyzeDeaths(transcript, characters, label) {
  // Transient non-quota errors we can retry against the SAME model
  const isTransientNonQuota = msg =>
    /high demand|overloaded|UNAVAILABLE|INTERNAL|503|502|504|DEADLINE_EXCEEDED|temporarily/i.test(msg) &&
    !/quota|free_tier|RESOURCE_EXHAUSTED/i.test(msg);
  // Quota errors mean: stop retrying this model, fall back to next one
  const isQuotaExhausted = msg => /quota|free_tier|RESOURCE_EXHAUSTED/i.test(msg);

  const models = [GEMINI_MODEL, ...GEMINI_FALLBACKS];
  let lastErr;

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt === 1 && model !== GEMINI_MODEL) console.log(`[${label}] Falling back to model: ${model}`);
        return await _geminiCall(transcript, characters, label, model);
      } catch (e) {
        lastErr = e;
        if (isQuotaExhausted(e.message)) {
          console.log(`[${label}] ${model} quota exhausted â€” trying next model`);
          break; // exit retry loop, go to next model
        }
        if (attempt < 3 && isTransientNonQuota(e.message)) {
          const waitS = attempt * 5;
          console.log(`[${label}] ${model} transient error â€” retry ${attempt}/2 in ${waitS}s`);
          await new Promise(r => setTimeout(r, waitS * 1000));
        } else {
          throw e;
        }
      }
    }
  }
  throw lastErr;
}

function printReport(label, a) {
  console.log(`\n${'â•'.repeat(60)}\n  ${label} â€” DEATH REPORT\n${'â•'.repeat(60)}`);
  console.log(`Summary: ${a.episode_summary}\n`);
  if (a.deaths?.length) {
    console.log(`Deaths (${a.deaths.length}):\n`);
    for (const d of a.deaths) {
      const icon = d.type === 'on_screen' ? '[ON-SCREEN]' : d.type === 'referenced' ? '[REFERENCED]' : '[IMPLIED]';
      console.log(`  ${icon} ${d.character} â€” confidence: ${d.confidence}`);
      console.log(`    Cause:    ${d.cause_of_death}`);
      if (d.timestamp && d.timestamp !== 'N/A') console.log(`    Time:     ${d.timestamp}`);
      console.log(`    Evidence: ${d.evidence}\n`);
    }
  } else {
    console.log('  No deaths detected.\n');
  }
  if (a.characters_at_risk?.length) {
    console.log('At risk:');
    for (const c of a.characters_at_risk) console.log(`  - ${c.character}: ${c.reason}`);
    console.log();
  }
  console.log(`Totals: ${a.total_deaths_on_screen || 0} on-screen, ${a.total_deaths_referenced || 0} referenced\n`);
}

// â”€â”€ MAIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node hotstar_scanner.js <show_url> <season> <ep1> [ep2] ...');
    console.error('Example: node hotstar_scanner.js https://www.hotstar.com/in/shows/panchayat/1260099902 3 1 2');
    process.exit(1);
  }

  const showUrl  = args[0];
  const season   = parseInt(args[1]);
  const episodes = args.slice(2).map(Number);
  const T        = Date.now();

  console.log(`\n${'â•'.repeat(54)}`);
  console.log(`  HOTSTAR FORENSIC SCANNER â€” Season ${season}, ${episodes.length} episode(s)`);
  console.log(`${'â•'.repeat(54)}\n`);

  const browser = await launchBrowser();
  const results = [];
  let pending   = null;  // overlapping Gemini call from previous episode

  for (const ep of episodes) {
    const label = `S${String(season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`;
    const t0    = Date.now();

    // Resolve this specific episode's URL via network interception
    let info;
    try {
      info = await resolveEpisodeUrl(browser, showUrl, season, ep);
    } catch (e) {
      console.error(`[${label}] Resolve failed: ${e.message}`);
      continue;
    }

    // Capture subtitles (page lifecycle managed inside)
    console.log(`\n[${label}] "${info.title}" â€” capturing subtitles...`);
    const vttContent = await captureSubtitles(browser, info.url);

    if (!vttContent) {
      console.error(`[${label}] No subtitles captured â€” skipping.`);
      continue;
    }

    // Save raw VTT for inspection
    fs.promises.writeFile(`${label}_subtitles.vtt`, vttContent).catch(() => {});

    const { transcript, lineCount, characters } = parseAndCleanVtt(vttContent);
    console.log(`[${label}] ${lineCount} lines, ${characters.length} characters detected (${Date.now() - t0}ms)`);

    if (!lineCount) {
      console.error(`[${label}] Transcript is empty after cleaning â€” skipping.`);
      continue;
    }

    // Save the cleaned transcript so analysis can be retried later (without re-capturing)
    fs.promises.writeFile(`${label}_transcript.txt`,
      `=== Characters detected ===\n${characters.join(', ')}\n\n=== Transcript ===\n${transcript}`
    ).catch(() => {});

    // Await previous Gemini call (overlapped with current subtitle capture)
    if (pending) {
      const { label: pl, promise: pp } = pending;
      try {
        const r = await pp;
        results.push({ label: pl, analysis: r });
        printReport(pl, r);
        fs.promises.writeFile(`${pl}_death_report.json`, JSON.stringify(r, null, 2)).catch(() => {});
      } catch (e) {
        console.error(`[${pl}] Gemini error: ${e.message}`);
      }
    }

    // Fire Gemini call for this episode (runs while next episode loads)
    console.log(`[${label}] Sending ${transcript.length} chars to Gemini...`);
    pending = { label, promise: analyzeDeaths(transcript, characters, label) };
  }

  // Flush last pending Gemini call
  if (pending) {
    const { label, promise } = pending;
    try {
      const r = await promise;
      results.push({ label, analysis: r });
      printReport(label, r);
      fs.promises.writeFile(`${label}_death_report.json`, JSON.stringify(r, null, 2)).catch(() => {});
    } catch (e) {
      console.error(`[${label}] Gemini error: ${e.message}`);
    }
  }

  // Race browser.close() against a 5s timeout â€” Chrome on Windows sometimes hangs on clean shutdown
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(r => setTimeout(r, 5000)),
  ]);
  try { execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' }); } catch {}
  geminiAgent.destroy();

  const elapsed = ((Date.now() - T) / 1000).toFixed(1);
  console.log(`\n${'â•'.repeat(54)}\n  COMPLETE â€” ${episodes.length} episode(s) in ${elapsed}s\n${'â•'.repeat(54)}`);
  let tOn = 0, tRef = 0;
  for (const r of results) {
    const on  = r.analysis.total_deaths_on_screen  || 0;
    const ref = r.analysis.total_deaths_referenced || 0;
    tOn += on; tRef += ref;
    const names = (r.analysis.deaths || []).map(d => d.character).join(', ') || 'None';
    console.log(`  ${r.label}: ${on} on-screen, ${ref} referenced â€” ${names}`);
  }
  console.log(`\n  TOTAL: ${tOn} on-screen, ${tRef} referenced\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
