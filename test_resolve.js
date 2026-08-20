const https = require('https');

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function extractHydrationData(html) {
  const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
  return match ? JSON.parse(match[1]) : null;
}

async function resolveEpisode(showAsin, targetSeason, targetEpisode) {
  const startUrl = `https://www.amazon.co.uk/gp/video/detail/${showAsin}/`;
  let html = await fetchHtml(startUrl);
  let data = extractHydrationData(html);
  
  if (!data) throw new Error("Could not find hydration data");
  
  // Find the season in the seasons list
  const seasonsList = data.init.preparations.body.atf.state.seasons[showAsin] || Object.values(data.init.preparations.body.atf.state.seasons)[0];
  const seasonObj = seasonsList.find(s => s.sequenceNumber === targetSeason);
  
  if (!seasonObj) throw new Error(`Season ${targetSeason} not found`);
  
  // If the target season is not the currently loaded one, fetch the correct season page
  if (!seasonObj.isSelected) {
    const seasonUrl = `https://www.amazon.co.uk/gp/video/detail/${seasonObj.seasonId}/`;
    html = await fetchHtml(seasonUrl);
    data = extractHydrationData(html);
  }
  
  // Now find the episode
  const episodes = data.init.preparations.body.btf.state.detail.detail;
  for (const [asin, details] of Object.entries(episodes)) {
    if (details.episodeNumber === targetEpisode) {
      return `https://www.amazon.co.uk/gp/video/detail/${asin}/`;
    }
  }
  
  throw new Error(`Episode ${targetEpisode} not found in season ${targetSeason}`);
}

resolveEpisode('B0DWSGK5GS', 2, 5)
  .then(url => console.log('Found URL:', url))
  .catch(console.error);

resolveEpisode('B0DWSGK5GS', 1, 3)
  .then(url => console.log('Found URL:', url))
  .catch(console.error);

