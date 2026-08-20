#!/usr/bin/env node
'use strict';
const fs = require('fs');
const https = require('https');
const http = require('http');
const puppeteer = require('puppeteer');
const path = require('path');

// CONFIG
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(__dirname, 'chrome_subs_profile');
const SUB_TIMEOUT = 15000;
const GEMINI_TIMEOUT = 120000;

// PRE-COMPILED
const RE_ASIN = /\/(?:dp|detail|product)\/([A-Z0-9]{10})/i;
const RE_DOMAIN = /https?:\/\/(www\.[^/]+)/;
const RE_HYDRATION = /<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i;
const RE_P_TAG = /<p\s+begin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi;
const RE_BR = /<br\s*\/?>/gi;
const RE_TAGS = /<[^>]+>/g;
const RE_WS = /\s+/g;
const RE_MUSIC_ONLY = /^â™ª+\s*â™ª*$/;
const RE_MUSIC_LEAD = /^â™ª\s*/;
const RE_MUSIC_TRAIL = /\s*â™ª+$/;
const RE_SPEAKER_BRACKET = /\[([A-Za-z'.]+)\]/;
const RE_SPEAKER_COLON = /^([A-Z][A-Z\s'.]+):\s/;
const BLOCKED_TYPES = new Set(['image','stylesheet','font']);
const SFX = new Set('laughs,sighs,gasps,groans,scoffs,chuckles,coughs,sniffs,exhales,inhales,crying,screaming,grunts,whimpers,sobbing,panting,knocking,doorbell,phone,song,music,indistinct,wind,thunder,gunshot,explosion,applause,cheering,laughter,clears,exclaims,whispers,giggles,school,excited,whooping,others,loud,both,door,laughing,all,groaning,band,people,engine,sniffling,knock,stammers,line,rings,chatter,closes,starts,ringing,warming,bell,softly,weakly,quietly,sharply,continues,playing,faintly,vibrating,whooshing,hip,horn,tires,siren,static,beeping,buzzing,clicking,ticking,crackling,rustling,squeaking,thudding,clanking,clattering,hammering,dripping,splashing,pouring,birds,dogs,crickets,wolves,rain,footsteps'.split(','));
const ENTITIES = {'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&apos;':"'"};
const RE_ENT = /&(?:amp|lt|gt|quot|#39|apos);/g;
const geminiAgent = new https.Agent({keepAlive:true,maxSockets:4});

// FAST HTTP â€” Buffer-based with keep-alive
const zlib=require('zlib');
const httpAgent = new https.Agent({keepAlive:true,maxSockets:6});
function httpGet(url,timeout=10000){
  return new Promise((resolve,reject)=>{
    const mod=url.startsWith('https')?https:http;
    const req=mod.get(url,{
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept-Encoding':'gzip,deflate,br'},
      agent:url.startsWith('https')?httpAgent:undefined,
      timeout
    },res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location)
        return resolve(httpGet(new URL(res.headers.location,url).href,timeout));
      const enc=res.headers['content-encoding'];
      let stream=res;
      if(enc==='gzip')stream=res.pipe(zlib.createGunzip());
      else if(enc==='deflate')stream=res.pipe(zlib.createInflate());
      else if(enc==='br')stream=res.pipe(zlib.createBrotliDecompress());
      const chunks=[];
      stream.on('data',c=>chunks.push(c));
      stream.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error',()=>{
        // Fallback: retry without compression
        const req2=mod.get(url,{
          headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
          timeout
        },res2=>{
          const c2=[];
          res2.on('data',c=>c2.push(c));
          res2.on('end',()=>resolve(Buffer.concat(c2).toString('utf8')));
        });
        req2.on('error',reject);
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
  });
}

// STEP 1: Batch resolve season episodes (1-2 HTTP calls)
async function resolveSeasonEpisodes(showUrl,targetSeason){
  const am=showUrl.match(RE_ASIN);
  if(!am)throw new Error('Cannot extract ASIN');
  const showAsin=am[1].toUpperCase();
  const dm=showUrl.match(RE_DOMAIN);
  const domain=dm?dm[1]:'www.amazon.co.uk';
  const t0=Date.now();

  let html=await httpGet(`https://${domain}/gp/video/detail/${showAsin}/`);
  let m=html.match(RE_HYDRATION);
  if(!m)throw new Error('No hydration data found');
  let data=JSON.parse(m[1]);

  const sm=data.init.preparations.body.atf.state.seasons;
  const sl=sm[showAsin]||Object.values(sm)[0];
  const so=sl.find(s=>s.sequenceNumber===targetSeason);
  if(!so)throw new Error(`Season ${targetSeason} not found. Available: ${sl.map(s=>s.sequenceNumber)}`);

  if(!so.isSelected){
    html=await httpGet(`https://${domain}/gp/video/detail/${so.seasonId}/`);
    m=html.match(RE_HYDRATION);
    if(!m)throw new Error('No hydration data on season page');
    data=JSON.parse(m[1]);
  }

  const eps=data.init.preparations.body.btf.state.detail.detail;
  const map={};
  for(const[asin,d]of Object.entries(eps)){
    map[d.episodeNumber]={asin,url:`https://${domain}/gp/video/detail/${asin}/`,title:d.title};
  }
  console.log(`[RESOLVE] ${Object.keys(map).length} episodes in ${Date.now()-t0}ms`);
  return map;
}

// STEP 2: Capture subtitle URL â€” AGGRESSIVE resource blocking + domcontentloaded
async function captureSubtitleUrl(page,episodeUrl){
  // Block everything except scripts/XHR/fetch â€” massive speedup
  await page.setRequestInterception(true);
  page.on('request',req=>{
    if(BLOCKED_TYPES.has(req.resourceType())) req.abort();
    else req.continue();
  });

  return new Promise(async(resolve)=>{
    let done=false;
    const finish=(v)=>{if(done)return;done=true;page.off('response',handler);resolve(v);};

    const handler=async(response)=>{
      if(done)return;
      const url=response.url();
      const ct=response.headers()['content-type']||'';
      // Priority: GetPlaybackResources JSON
      if(ct.includes('application/json')||url.includes('GetPlaybackResources')){
        try{
          const t=await response.text();
          const j=JSON.parse(t);
          if(j.subtitleUrls?.length>0){
            const s=j.subtitleUrls.find(s=>s.languageCode==='en-gb'&&s.type==='sdh')
              ||j.subtitleUrls.find(s=>s.languageCode?.startsWith('en')&&s.type==='sdh')
              ||j.subtitleUrls.find(s=>s.languageCode?.startsWith('en'))
              ||j.subtitleUrls[0];
            if(s)finish(s.url);
          }
        }catch{}
      }
      // Fallback: direct TTML2
      if(!done&&(url.includes('.ttml2')||url.includes('.dfxp'))&&!ct.includes('json')){
        try{const b=await response.buffer();if(b.length>5000)finish(b.toString('utf8'));}catch{}
      }
    };

    page.on('response',handler);

    // Use domcontentloaded â€” don't wait for images/css/fonts to finish
    try{await page.goto(episodeUrl,{waitUntil:'domcontentloaded',timeout:20000});}catch{}

    // Tight poll â€” 250ms intervals, bail the INSTANT we have data
    const deadline=Date.now()+SUB_TIMEOUT;
    while(!done&&Date.now()<deadline) await new Promise(r=>setTimeout(r,250));
    if(!done)finish(null);
  });
}

// STEP 3: Parse TTML2 â€” single-pass, merged speaker compression
function parseAndClean(xml){
  const lines=[];
  const chars=new Set();
  RE_P_TAG.lastIndex=0;
  let m,lastSpeaker='',lastTime='';

  while((m=RE_P_TAG.exec(xml))!==null){
    let t=m[2].replace(RE_BR,' ').replace(RE_TAGS,'');
    t=t.replace(RE_ENT,m=>ENTITIES[m]||m).replace(RE_WS,' ').trim();
    if(!t||RE_MUSIC_ONLY.test(t))continue;
    t=t.replace(RE_MUSIC_LEAD,'').replace(RE_MUSIC_TRAIL,'').trim();
    if(!t)continue;

    const br=t.match(RE_SPEAKER_BRACKET);
    if(br&&!SFX.has(br[1].toLowerCase()))chars.add(br[1]);
    const co=t.match(RE_SPEAKER_COLON);
    if(co)chars.add(co[1].trim());

    // Compact timestamp: strip trailing .000 and leading zeros
    const ts=m[1].replace(/\.0+$/,'').replace(/^0+:/,'');
    
    // Merge consecutive lines from same speaker to compress transcript
    const speaker=co?co[1].trim():(br?br[1]:'');
    if(speaker&&speaker===lastSpeaker&&lines.length>0){
      // Append to previous line instead of creating new one
      const prevIdx=lines.length-1;
      const colonIdx=lines[prevIdx].indexOf('] ');
      if(colonIdx>0){
        const prevText=lines[prevIdx].substring(colonIdx+2);
        const newText=co?t.substring(co[0].length):t;
        lines[prevIdx]=`[${lastTime}] ${prevText} ${newText}`;
        continue;
      }
    }
    lastSpeaker=speaker;
    lastTime=ts;
    lines.push(`[${ts}] ${t}`);
  }

  return{transcript:lines.join('\n'),lineCount:lines.length,characters:[...chars]};
}

// STEP 4: Gemini analysis â€” with retry, compressed prompt, keep-alive
async function analyzeDeaths(transcript,characters,label,retries=3){
  for(let attempt=1;attempt<=retries;attempt++){
    try{
      return await _geminiCall(transcript,characters,label);
    }catch(e){
      if(attempt<retries&&(e.message.includes('high demand')||e.message.includes('429')||e.message.includes('RESOURCE_EXHAUSTED'))){
        const wait=Math.pow(2,attempt)*1000;
        console.log(`[${label}] Gemini rate-limited, retry ${attempt}/${retries} in ${wait/1000}s...`);
        await new Promise(r=>setTimeout(r,wait));
      }else throw e;
    }
  }
}
// Sanitize malformed JSON from Gemini (trailing commas, control chars, etc.)
function sanitizeJson(str){
  // Strip markdown code fences if present
  let s=str.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim();
  // Remove trailing commas before } or ]
  s=s.replace(/,\s*([}\]])/g,'$1');
  // Remove control characters except newline/tab
  s=s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
  return s;
}

function _geminiCall(transcript,characters,label){
  const prompt=`You are a forensic analyst. Analyze this TV transcript and identify EVERY character death â€” on-screen, referenced, or implied.

Rules:
- "on_screen" = character dies during THIS episode
- "referenced" = death happened before this episode but is mentioned/discussed
- "implied" = strong contextual evidence suggests death but not explicitly confirmed
- Death indicators: dead/died/killed/murdered/passed away/funeral, gunshots+silence, "we lost her/gone forever", "took care of it/won't be coming back", cancer/terminal, character vanishes after violence
- IGNORE figurative speech ("you're killing me", "I could die of embarrassment")
- Confidence: "high" (explicit), "medium" (strongly implied), "low" (ambiguous)

Characters detected: ${characters.join(', ')}

Transcript:
${transcript}

Respond with valid JSON matching this exact structure.`;

  // Use responseSchema to force valid JSON structure
  const schema={
    type:'OBJECT',
    properties:{
      episode_summary:{type:'STRING'},
      deaths:{type:'ARRAY',items:{type:'OBJECT',properties:{
        character:{type:'STRING'},
        type:{type:'STRING',enum:['on_screen','referenced','implied']},
        confidence:{type:'STRING',enum:['high','medium','low']},
        timestamp:{type:'STRING'},
        cause_of_death:{type:'STRING'},
        evidence:{type:'STRING'}
      },required:['character','type','confidence','cause_of_death','evidence']}},
      total_deaths_on_screen:{type:'INTEGER'},
      total_deaths_referenced:{type:'INTEGER'},
      characters_at_risk:{type:'ARRAY',items:{type:'OBJECT',properties:{
        character:{type:'STRING'},
        reason:{type:'STRING'}
      },required:['character','reason']}}
    },
    required:['episode_summary','deaths','total_deaths_on_screen','total_deaths_referenced']
  };

  return new Promise((resolve,reject)=>{
    const payload=JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{
        temperature:0.1,
        maxOutputTokens:8192,
        responseMimeType:'application/json',
        responseSchema:schema
      }
    });
    const buf=Buffer.from(payload);

    const req=https.request({
      hostname:'generativelanguage.googleapis.com',
      path:`/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':buf.length},
      agent:geminiAgent,
      timeout:GEMINI_TIMEOUT
    },res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        try{
          const j=JSON.parse(body);
          if(j.error)return reject(new Error(j.error.message));
          const txt=j.candidates?.[0]?.content?.parts?.[0]?.text;
          if(!txt)return reject(new Error(`Empty response for ${label}`));
          // Try direct parse first, then sanitized parse
          try{resolve(JSON.parse(txt));}catch(e1){
            try{resolve(JSON.parse(sanitizeJson(txt)));}catch(e2){
              console.error(`[${label}] Raw Gemini text (first 500 chars): ${txt.substring(0,500)}`);
              reject(new Error(`JSON parse failed for ${label}: ${e2.message}`));
            }
          }
        }catch(e){reject(new Error(`API response parse: ${e.message}\n${body.substring(0,300)}`));}
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy();reject(new Error(`Timeout ${label}`));});
    req.write(buf);
    req.end();
  });
}

// STEP 5: Display
function printReport(label,a){
  console.log(`\n${'â•'.repeat(60)}\n  ${label} â€” DEATH REPORT\n${'â•'.repeat(60)}`);
  console.log(`ðŸ“‹ ${a.episode_summary}\n`);
  if(a.deaths?.length){
    console.log(`ðŸ’€ DEATHS (${a.deaths.length}):\n`);
    for(const d of a.deaths){
      const i=d.type==='on_screen'?'ðŸ”´':d.type==='referenced'?'ðŸ“–':'â“';
      console.log(`   ${i} ${d.character} [${d.type}] (${d.confidence})`);
      console.log(`      Cause: ${d.cause_of_death}`);
      if(d.timestamp&&d.timestamp!=='N/A')console.log(`      Time: ${d.timestamp}`);
      console.log(`      Evidence: "${d.evidence}"\n`);
    }
  }else console.log(`   âœ… No deaths detected.\n`);
  if(a.characters_at_risk?.length){
    console.log(`âš ï¸  AT RISK:`);
    for(const c of a.characters_at_risk)console.log(`   - ${c.character}: ${c.reason}`);
    console.log();
  }
  console.log(`ðŸ“Š ${a.total_deaths_on_screen||0} on-screen, ${a.total_deaths_referenced||0} referenced\n`);
}

// MAIN â€” Maximum pipeline overlap
async function main(){
  const args=process.argv.slice(2);
  if(args.length<3){
    console.error('Usage: node forensic_scanner.js <show_url> <season> <ep1> [ep2] ...');
    process.exit(1);
  }
  const showUrl=args[0],season=parseInt(args[1]),episodes=args.slice(2).map(Number);
  const T=Date.now();

  console.log(`\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—`);
  console.log(`â•‘  FORENSIC SCANNER v2 â€” ${episodes.length} ep(s), Season ${season}`);
  console.log(`â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n`);

  // PARALLEL: resolve episodes + launch browser simultaneously
  const[episodeMap,browser]=await Promise.all([
    resolveSeasonEpisodes(showUrl,season),
    puppeteer.launch({
      headless:false,defaultViewport:null,
      executablePath:CHROME_PATH,userDataDir:PROFILE_DIR,
      args:['--no-sandbox','--disable-setuid-sandbox',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--disable-extensions','--disable-component-extensions-with-background-pages',
        '--disable-default-apps','--no-first-run',
        '--disable-hang-monitor','--disable-prompt-on-repost',
        '--metrics-recording-only','--no-default-browser-check']
    })
  ]);

  for(const ep of episodes){
    if(!episodeMap[ep]){
      console.error(`Episode ${ep} not found.`);
      await browser.close();process.exit(1);
    }
  }

  const results=[];
  let pending=null;

  // Pre-create first page during validation
  let nextPage=await browser.newPage();

  for(let i=0;i<episodes.length;i++){
    const ep=episodes[i],info=episodeMap[ep];
    const label=`S${String(season).padStart(2,'0')}E${String(ep).padStart(2,'0')}`;
    const t0=Date.now();
    console.log(`\n[${label}] â–¶ "${info.title}" (${info.asin})`);

    // Use pre-created page
    const page=nextPage;
    console.log(`[${label}] Intercepting subtitles...`);
    const subResult=await captureSubtitleUrl(page,info.url);

    // Pre-create NEXT page while we process current (overlap tab creation)
    const closePromise=page.close();
    if(i<episodes.length-1) nextPage=await browser.newPage();
    await closePromise;

    if(!subResult){console.error(`[${label}] âœ— No subtitles â€” skipping.`);continue;}

    // Get TTML2 content + save XML in parallel
    let xml;
    if(subResult.startsWith('http')){
      console.log(`[${label}] Downloading TTML2...`);
      xml=await httpGet(subResult);
    }else xml=subResult;

    // Async write â€” don't block on disk I/O
    fs.promises.writeFile(`${label}_subtitles.xml`,xml).catch(()=>{});

    // Parse (instant)
    const{transcript,lineCount,characters}=parseAndClean(xml);
    console.log(`[${label}] ${lineCount} lines, ${characters.length} chars, ${transcript.length} bytes (${Date.now()-t0}ms)`);
    if(!lineCount){console.error(`[${label}] âœ— Empty transcript.`);continue;}

    // Drain previous Gemini (pipeline overlap)
    if(pending){
      const{label:pl,promise:pp}=pending;
      try{
        const r=await pp;
        results.push({label:pl,analysis:r});
        printReport(pl,r);
        fs.promises.writeFile(`${pl}_death_report.json`,JSON.stringify(r,null,2)).catch(()=>{});
      }catch(e){console.error(`[${pl}] Gemini: ${e.message}`);}
    }

    // Fire Gemini (runs while next episode captures)
    console.log(`[${label}] â†’ Gemini (${transcript.length} chars)...`);
    pending={label,promise:analyzeDeaths(transcript,characters,label)};
  }

  // Drain final
  if(pending){
    const{label,promise}=pending;
    try{
      const r=await promise;
      results.push({label,analysis:r});
      printReport(label,r);
      fs.promises.writeFile(`${label}_death_report.json`,JSON.stringify(r,null,2)).catch(()=>{});
    }catch(e){console.error(`[${label}] Gemini: ${e.message}`);}
  }

  await browser.close();
  geminiAgent.destroy();
  httpAgent.destroy();

  // Summary
  const elapsed=((Date.now()-T)/1000).toFixed(1);
  console.log(`\n${'â•'.repeat(60)}\n  COMPLETE â€” ${episodes.length} ep(s) in ${elapsed}s\n${'â•'.repeat(60)}`);
  let tOn=0,tRef=0;
  for(const r of results){
    const on=r.analysis.total_deaths_on_screen||0,ref=r.analysis.total_deaths_referenced||0;
    tOn+=on;tRef+=ref;
    console.log(`  ${r.label}: ${on} on-screen, ${ref} ref â€” [${(r.analysis.deaths||[]).map(d=>d.character).join(', ')||'None'}]`);
  }
  console.log(`\n  TOTAL: ${tOn} on-screen, ${tRef} referenced\n`);
}

main().catch(e=>{console.error('Fatal:',e.message);process.exit(1);});
