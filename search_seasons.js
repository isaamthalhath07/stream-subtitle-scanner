const fs = require('fs');
const html = fs.readFileSync('amazon_page.html', 'utf8');
const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
const data = JSON.parse(match[1]);

// Check for seasons list
console.log('--- Seasons ---');
let foundSeasonKeys = [];
function searchSeasons(obj, path = '') {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
    obj.forEach((val, i) => searchSeasons(val, `${path}[${i}]`));
    } else {
    for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase().includes('season')) {
        foundSeasonKeys.push(`${path}.${k}`);
        }
        searchSeasons(v, `${path}.${k}`);
    }
    }
}
searchSeasons(data, 'root');
console.log([...new Set(foundSeasonKeys)]);
