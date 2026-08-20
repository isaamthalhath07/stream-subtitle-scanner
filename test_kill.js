const {execSync} = require('child_process');
console.log('Killing Chrome...');
try { execSync('taskkill /IM chrome.exe /F', {stdio:'pipe', timeout:5000}); } catch {}
console.log('Waiting 5s...');
for (let i=0;i<5;i++) {
  execSync('powershell -Command "Start-Sleep -Seconds 1"', {stdio:'ignore'});
  process.stdout.write('.');
}
console.log('\nChecking...');
try {
  const r = execSync('tasklist', {encoding:'utf8', timeout:5000});
  const chromeLines = r.split('\n').filter(l => l.includes('chrome.exe'));
  console.log(`Chrome processes: ${chromeLines.length}`);
  if (chromeLines.length > 0) console.log(chromeLines[0]);
} catch(e) { console.log('Error:', e.message); }
