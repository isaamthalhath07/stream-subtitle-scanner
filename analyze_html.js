const fs = require('fs');

const html = fs.readFileSync('amazon_page.html', 'utf8');

// Find all script tags
const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;

console.log('--- Script Tags ---');
while ((match = scriptRegex.exec(html)) !== null) {
  const attrs = match[1];
  const body = match[2];
  
  if (body.length > 500) {
    console.log(`\nScript #${count} (Length: ${body.length})`);
    console.log(`Attrs: ${attrs}`);
    console.log(`Preview: ${body.substring(0, 200).replace(/\n/g, ' ')}...`);
    
    // Look for keywords like "episode", "season", "GraphQL", "props"
    if (/episode/i.test(body)) console.log(' -> CONTAINS: episode');
    if (/season/i.test(body)) console.log(' -> CONTAINS: season');
    if (/B0DWSGK5GS/i.test(body)) console.log(' -> CONTAINS: ASIN (B0DWSGK5GS)');
  }
  count++;
}
