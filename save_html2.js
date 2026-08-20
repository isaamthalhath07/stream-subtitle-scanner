const https = require('https');
const UA = 'Mozilla/5.0';

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

async function main() {
  const { body } = await httpGet('https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/');
  require('fs').writeFileSync('test_page.html', body);
  console.log('Saved length:', body.length);
}
main();
