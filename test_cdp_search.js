const UA = 'Mozilla/5.0';
async function test() {
  const url = 'https://atv-ps.amazon.com/cdp/catalog/Search?phrase=The%20Boys&contentType=TV&pageSize=5&regionCode=US&format=json';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    console.log(res.status);
    const data = await res.text();
    console.log(data.slice(0, 300));
  } catch(e) { console.error(e.message); }
}
test();
