const fs = require('fs');

const html = fs.readFileSync('amazon_page.html', 'utf8');

// 1. Look for API endpoints
console.log('--- API Endpoints ---');
const apis = html.match(/https:\/\/[^\/]+\/[^"'\\]*(?:api|graphql)[^"'\\]*/gi);
if (apis) {
  [...new Set(apis)].forEach(api => console.log(api));
} else {
  console.log('None found');
}

// 2. Look for /dp/ or /gp/video/detail/ to see where episodes are referenced
console.log('\n--- Episode Links ---');
const links = html.match(/\/gp\/video\/detail\/[A-Z0-9]{10}\//gi);
if (links) {
  const unique = [...new Set(links)];
  console.log(`Found ${unique.length} unique links. Examples:`);
  console.log(unique.slice(0, 10));
} else {
  console.log('No /gp/video/detail/ links found');
}

// 3. Look for GetCatalogMetadata or similar words
console.log('\n--- Catalog Metadata ---');
if (html.includes('GetCatalogMetadata')) console.log('Contains GetCatalogMetadata');
if (html.includes('cdp/catalog')) console.log('Contains cdp/catalog');

// 4. Parse hydration JSON and find episodes
console.log('\n--- Hydration Data Deep Search ---');
try {
  const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
  if (match) {
    const data = JSON.parse(match[1]);
    let found = [];
    
    function search(obj, path = '') {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach((val, i) => search(val, `${path}[${i}]`));
      } else {
        for (const [k, v] of Object.entries(obj)) {
          if (k.toLowerCase().includes('episode')) {
            found.push(`${path}.${k} = ${v}`);
          }
          if (typeof v === 'string' && v.match(/^[A-Z0-9]{10}$/)) {
            // Might be ASIN
            if (k === 'id' || k === 'titleId' || k === 'asin') {
              found.push(`${path}.${k} = ${v}`);
            }
          }
          search(v, `${path}.${k}`);
        }
      }
    }
    search(data, 'root');
    console.log(`Found ${found.length} episode/ASIN references.`);
    if (found.length > 0) {
      console.log(found.slice(0, 20).join('\n'));
    }
  }
} catch (e) {
  console.error('Error parsing hydration data:', e.message);
}
