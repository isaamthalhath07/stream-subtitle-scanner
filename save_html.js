const https = require('https');
const UA = 'Mozilla/5.0';
https.get('https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/', { headers: { 'User-Agent': UA } }, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    require('fs').writeFileSync('test_page.html', body);
  });
});
