const fs = require('fs');

const html = fs.readFileSync('amazon_page.html', 'utf8');
const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
const data = JSON.parse(match[1]);

const eps = data.init.preparations.body.btf.state.detail.detail;
console.log('Keys in eps:', Object.keys(eps));

const ep1 = Object.values(eps).find(e => e.episodeNumber === 1);
console.log('Episode 1:');
console.log(JSON.stringify(ep1, null, 2));

const episodeList = data.init.preparations.body.atf.state.episodeList;
if (episodeList) {
    console.log('\nEpisode List keys:', Object.keys(episodeList));
}
