const fs = require('fs');
const html = fs.readFileSync('amazon_page.html', 'utf8');
const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
const data = JSON.parse(match[1]);

const seasons = data.init.preparations.body.atf.state.seasons['B0DWSGK5GS'];
console.log(JSON.stringify(seasons, null, 2));
