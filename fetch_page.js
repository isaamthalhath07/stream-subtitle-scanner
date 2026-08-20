const https = require('https');
const fs = require('fs');

https.get('https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
  }
}, (res) => {
  let body='';
  res.on('data', c=>body+=c);
  res.on('end', () => {
    fs.writeFileSync('amazon_page.html', body);
    console.log('Saved amazon_page.html, size:', body.length);
  });
}).on('error', console.error);
