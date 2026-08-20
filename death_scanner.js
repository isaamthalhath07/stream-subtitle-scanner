const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');
const path = require('path');

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  CONFIG
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(__dirname, 'chrome_subs_profile');

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  UTILITY: Fast HTTP fetch
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(httpGet(new URL(res.headers.location, url).href));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 1: Batch resolve ALL episode ASINs for a season in ONE request
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function resolveSeasonEpisodes(showUrl, targetSeason) {
  const asinMatch = showUrl.match(/\/(?:dp|detail|product)\/([A-Z0-9]{10})/i);
  const showAsin = asinMatch[1].toUpperCase();
  const domainMatch = showUrl.match(/https?:\/\/(www\.[^/]+)/);
  const domain = domainMatch ? domainMatch[1] : 'www.amazon.co.uk';

  console.log(`[RESOLVE] Fetching season ${targetSeason} metadata for ${showAsin}...`);
  const t0 = Date.now();
  
  let html = await httpGet(`https://${domain}/gp/video/detail/${showAsin}/`);
  let match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
  let data = JSON.parse(match[1]);

  const seasonsMap = data.init.preparations.body.atf.state.seasons;
  const seasonsList = seasonsMap[showAsin] || Object.values(seasonsMap)[0];
  const seasonObj = seasonsList.find(s => s.sequenceNumber === targetSeason);
  if (!seasonObj) throw new Error(`Season ${targetSeason} not found`);

  if (!seasonObj.isSelected) {
    html = await httpGet(`https://${domain}/gp/video/detail/${seasonObj.seasonId}/`);
    match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
    data = JSON.parse(match[1]);
  }

  const episodes = data.init.preparations.body.btf.state.detail.detail;
  const episodeMap = {};
  for (const [asin, details] of Object.entries(episodes)) {
    episodeMap[details.episodeNumber] = {
      asin,
      url: `https://${domain}/gp/video/detail/${asin}/`,
      title: details.title
    };
  }

  console.log(`[RESOLVE] Got ${Object.keys(episodeMap).length} episodes in ${Date.now() - t0}ms`);
  return episodeMap;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 2: Capture subtitle URL by intercepting GetPlaybackResources JSON
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function captureSubtitleUrl(page, episodeUrl) {
  return new Promise(async (resolve) => {
    let resolved = false;

    const handler = async (response) => {
      if (resolved) return;
      const url = response.url();
      const ct = response.headers()['content-type'] || '';

      // Intercept GetPlaybackResources JSON â€” grab subtitle URLs
      if (ct.includes('application/json') || url.includes('GetPlaybackResources')) {
        try {
          const text = await response.text();
          const json = JSON.parse(text);
          if (json.subtitleUrls && json.subtitleUrls.length > 0) {
            const enSub = json.subtitleUrls.find(s => s.languageCode === 'en-gb' && s.type === 'sdh')
                       || json.subtitleUrls.find(s => s.languageCode.startsWith('en'))
                       || json.subtitleUrls[0];
            if (enSub && !resolved) {
              resolved = true;
              page.off('response', handler);
              resolve(enSub.url);
            }
          }
        } catch (e) {}
      }

      // Fallback: direct TTML2 intercept
      if ((url.includes('.ttml2') || url.includes('.dfxp')) && !ct.includes('json')) {
        try {
          const buf = await response.buffer();
          if (buf.length > 5000 && !resolved) {
            resolved = true;
            page.off('response', handler);
            resolve(buf.toString('utf8'));
          }
        } catch (e) {}
      }
    };

    page.on('response', handler);

    try {
      await page.goto(episodeUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {}

    // Wait up to 10s extra for JSON to arrive
    for (let i = 0; i < 10 && !resolved; i++) {
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!resolved) {
      resolved = true;
      page.off('response', handler);
      resolve(null);
    }
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 3: Parse TTML2 XML â†’ Clean transcript (optimized, single-pass)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function parseAndClean(xml) {
  const lines = [];
  const chars = new Set();
  const pRe = /<p\s+begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi;
  const sfx = /^(laughs|sighs|gasps|groans|scoffs|chuckles|coughs|sniffs|exhales|inhales|crying|screaming|grunts|whimpers|sobbing|panting|knocking|doorbell|phone|song|music|indistinct|wind|thunder|gunshot|explosion|applause|cheering|laughter|clears|exclaims|whispers|giggles|school|excited|whooping|others|loud|both|door|laughing|all|groaning|band|people|engine|sniffling|knock|stammers|line|rings|chatter|closes|starts|ringing|warming|bell|softly|weakly|quietly|sharply|continues|playing|faintly|vibrating|whooshing|hip|horn|tires|siren|static|beeping|buzzing|clicking|ticking|crackling|rustling|squeaking|thudding|clanking|clattering|hammering|dripping|splashing|pouring|birds|dogs|crickets|wolves|rain|footsteps)/i;
  let m;

  while ((m = pRe.exec(xml)) !== null) {
    let text = m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || /^â™ª+\s*â™ª*$/.test(text)) continue;
    text = text.replace(/^â™ª\s*/, '').replace(/\s*â™ª+$/, '').trim();
    if (!text) continue;

    // Extract characters inline (single pass)
    const speakerBracket = text.match(/\[([A-Za-z'.]+)\]/);
    if (speakerBracket && !sfx.test(speakerBracket[1])) chars.add(speakerBracket[1]);
    const speakerColon = text.match(/^([A-Z][A-Z\s'.]+):\s/);
    if (speakerColon) chars.add(speakerColon[1].trim());

    lines.push(`[${m[1]}] ${text}`);
  }

  return { transcript: lines.join('\n'), lineCount: lines.length, characters: [...chars] };
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 4: Gemini analysis (non-blocking, pipelined)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function analyzeDeaths(transcript, characters, episodeLabel) {
  const prompt = `You are an expert forensic analyst. Analyze this TV episode transcript and identify EVERY character death â€” on-screen, referenced, or implied.

RULES:
1. "on_screen" = dies THIS episode. "referenced" = died before, mentioned now. "implied" = strong evidence but not confirmed.
2. DEATH INDICATORS: "dead/died/killed/murdered/passed away/funeral" | gunshots+silence | "we lost her/gone forever" | "took care of it/won't be coming back" | "cancer/terminal" | character vanishes after violence.
3. IGNORE figurative speech ("you're killing me", "I could die of embarrassment").
4. Confidence: "high" (explicit), "medium" (strongly implied), "low" (ambiguous).

CHARACTERS: ${characters.join(', ')}

TRANSCRIPT:
${transcript}

Return JSON:
{"episode_summary":"...","deaths":[{"character":"...","type":"on_screen|referenced|implied","confidence":"high|medium|low","timestamp":"HH:MM:SS or N/A","cause_of_death":"...","evidence":"..."}],"total_deaths_on_screen":0,"total_deaths_referenced":0,"characters_at_risk":[{"character":"...","reason":"..."}]}`;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json" }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) return reject(new Error(json.error.message));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error(`Parse error: ${e.message}\n${body.substring(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  STEP 5: Display report
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function printReport(label, analysis) {
  console.log(`\n${'â•'.repeat(60)}`);
  console.log(`  ${label} â€” DEATH REPORT`);
  console.log(`${'â•'.repeat(60)}`);
  console.log(`ðŸ“‹ ${analysis.episode_summary}\n`);
  if (analysis.deaths?.length) {
    for (const d of analysis.deaths) {
      const icon = d.type === 'on_screen' ? 'ðŸ”´' : d.type === 'referenced' ? 'ðŸ“–' : 'â“';
      console.log(`   ${icon} ${d.character} [${d.type}] (${d.confidence})`);
      console.log(`      Cause: ${d.cause_of_death}`);
      console.log(`      Evidence: "${d.evidence}"\n`);
    }
  } else {
    console.log(`   âœ… No deaths detected.\n`);
  }
  if (analysis.characters_at_risk?.length) {
    console.log(`âš ï¸  AT RISK:`);
    for (const c of analysis.characters_at_risk) console.log(`   - ${c.character}: ${c.reason}`);
  }
  console.log(`ðŸ“Š ${analysis.total_deaths_on_screen || 0} on-screen, ${analysis.total_deaths_referenced || 0} referenced\n`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  MAIN â€” Pipeline: capture next while analyzing current
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node death_scanner.js <show_url> <season> <episode1> [episode2] [episode3] ...');
    console.error('Example: node death_scanner.js "https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/" 5 4 5 6 7');
    process.exit(1);
  }

  const showUrl = args[0];
  const season = parseInt(args[1]);
  const episodes = args.slice(2).map(Number);
  const totalStart = Date.now();

  // 1) Batch-resolve all episode URLs in ONE request
  const episodeMap = await resolveSeasonEpisodes(showUrl, season);

  // Validate all requested episodes exist
  for (const ep of episodes) {
    if (!episodeMap[ep]) { console.error(`Episode ${ep} not found in season ${season}`); process.exit(1); }
  }

  // 2) Launch Chrome ONCE, reuse for all episodes
  console.log(`[BROWSER] Launching Chrome (reused for all ${episodes.length} episodes)...`);
  const browser = await puppeteer.launch({
    headless: false, defaultViewport: null,
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = [];
  let pendingAnalysis = null; // Gemini promise from previous episode

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    const label = `S${String(season).padStart(2,'0')}E${String(ep).padStart(2,'0')}`;
    const info = episodeMap[ep];
    const epStart = Date.now();

    console.log(`\n[${label}] â–¶ ${info.title} (${info.asin})`);

    // 3) Capture subtitle URL from browser (intercept JSON, not video playback)
    const page = await browser.newPage();
    console.log(`[${label}] Navigating & intercepting subtitle URL...`);
    const subResult = await captureSubtitleUrl(page, info.url);
    await page.close();

    if (!subResult) {
      console.error(`[${label}] âœ— No subtitles captured. Skipping.`);
      continue;
    }

    // 4) Get the actual TTML2 content
    let xml;
    if (subResult.startsWith('http')) {
      console.log(`[${label}] Downloading TTML2 directly from CDN...`);
      xml = await httpGet(subResult);
    } else {
      xml = subResult; // Already have the content from buffer intercept
    }

    // Save raw XML
    const xmlFile = `${label}_subtitles.xml`;
    fs.writeFileSync(xmlFile, xml);

    // 5) Parse transcript (instant, ~1ms)
    const { transcript, lineCount, characters } = parseAndClean(xml);
    console.log(`[${label}] Parsed ${lineCount} lines, ${characters.length} chars in ${Date.now() - epStart}ms`);

    // 6) Wait for previous Gemini analysis if any (pipeline overlap)
    if (pendingAnalysis) {
      const { label: prevLabel, promise } = pendingAnalysis;
      try {
        const prevResult = await promise;
        results.push({ label: prevLabel, analysis: prevResult });
        printReport(prevLabel, prevResult);
        fs.writeFileSync(`${prevLabel}_death_report.json`, JSON.stringify(prevResult, null, 2));
      } catch (e) { console.error(`[${prevLabel}] Gemini error: ${e.message}`); }
    }

    // 7) Fire off Gemini analysis (runs in background while we capture next episode)
    console.log(`[${label}] Sending ${transcript.length} chars to Gemini...`);
    pendingAnalysis = { label, promise: analyzeDeaths(transcript, characters, label) };
  }

  // 8) Wait for the last Gemini analysis
  if (pendingAnalysis) {
    const { label, promise } = pendingAnalysis;
    try {
      const result = await promise;
      results.push({ label, analysis: result });
      printReport(label, result);
      fs.writeFileSync(`${label}_death_report.json`, JSON.stringify(result, null, 2));
    } catch (e) { console.error(`[${label}] Gemini error: ${e.message}`); }
  }

  await browser.close();

  // 9) Final summary
  console.log(`\n${'â•'.repeat(60)}`);
  console.log(`  SCAN COMPLETE â€” ${episodes.length} episodes in ${((Date.now() - totalStart) / 1000).toFixed(1)}s`);
  console.log(`${'â•'.repeat(60)}`);
  let totalOnScreen = 0, totalReferenced = 0;
  for (const r of results) {
    const on = r.analysis.total_deaths_on_screen || 0;
    const ref = r.analysis.total_deaths_referenced || 0;
    totalOnScreen += on;
    totalReferenced += ref;
    const names = (r.analysis.deaths || []).map(d => d.character).join(', ') || 'None';
    console.log(`  ${r.label}: ${on} on-screen, ${ref} referenced â€” [${names}]`);
  }
  console.log(`\n  TOTAL: ${totalOnScreen} on-screen deaths, ${totalReferenced} referenced deaths`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
