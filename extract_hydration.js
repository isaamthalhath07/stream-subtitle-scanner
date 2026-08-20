const fs = require('fs');

const html = fs.readFileSync('amazon_page.html', 'utf8');

const match = html.match(/<script\s+id="dv-web-page-hydration-data"[^>]*>([\s\S]*?)<\/script>/i);
if (match) {
  const data = JSON.parse(match[1]);
  fs.writeFileSync('hydration_data.json', JSON.stringify(data, null, 2));
  console.log('Hydration data saved to hydration_data.json. Keys:', Object.keys(data));
  if (data.init && data.init.preparations) {
    console.log('Preparation keys:', Object.keys(data.init.preparations));
  }
} else {
  console.log('Not found');
}
