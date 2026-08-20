const https = require('https');
const UA = 'Mozilla/5.0';

https.get('https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/', { headers: { 'User-Agent': UA } }, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    // extract next data
    const m = body.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (m) {
      console.log('Found __NEXT_DATA__ (length):', m[1].length);
      const fs = require('fs');
      fs.writeFileSync('next_data.json', m[1]);
    } else {
      console.log('No __NEXT_DATA__');
    }

    const stateMatch = body.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i) ||
                       body.match(/window\.__ATVWebPlayerData__\s*=\s*({[\s\S]*?});?\s*<\/script>/i) ||
                       body.match(/"props"\s*:\s*({[\s\S]*?})\s*,\s*"page"/i);
    if (stateMatch) {
       console.log('Found embedded state (length):', stateMatch[1].length);
       const fs = require('fs');
       fs.writeFileSync('state.json', stateMatch[1]);
    } else {
       console.log('No embedded state');
    }
  });
});
