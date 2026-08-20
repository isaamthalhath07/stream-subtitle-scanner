const d = require('./hs_resp_1_1779179204153.json');
const j = typeof d === 'string' ? JSON.parse(d) : d;
const page = j.success.page;
const tray = page.spaces.tray;
const epWidget = tray.widget_wrappers[0].widget;
const data = epWidget.data;

console.log('tray_items type:', typeof data.tray_items);
console.log('tray_items keys:', data.tray_items ? Object.keys(data.tray_items) : 'null');

// It's an object, not array
const ti = data.tray_items;
if (ti && ti.widget_wrappers) {
  console.log('\ntray_items.widget_wrappers count:', ti.widget_wrappers.length);
  ti.widget_wrappers.forEach((ww, i) => {
    console.log(`\n--- Episode ${i + 1} ---`);
    const card = ww.widget || ww;
    console.log('Template:', ww.template);
    // Get nested card data
    const cardData = card.data || {};
    console.log('Data:', JSON.stringify(cardData).substring(0, 800));
    if (card.widget_commons) {
      console.log('Actions:', JSON.stringify(card.widget_commons.actions || {}).substring(0, 300));
    }
  });
} else {
  console.log('tray_items full:', JSON.stringify(ti).substring(0, 3000));
}
