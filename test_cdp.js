const UA = 'Mozilla/5.0';
async function tryCdpApi(asin, domain, season, episode) {
  const isEu = /\.(uk|de|fr|it|es)$/i.test(domain);
  const endpoint = isEu ? 'atv-ps-eu.amazon.co.uk' : 'atv-ps.amazon.com';
  const apiUrl = `https://${endpoint}/cdp/catalog/GetCatalogMetadata?titleID=${asin}&seasonNumber=${season}&episodeNumber=${episode}&format=json`;
  console.log('Fetching:', apiUrl);
  try {
    const res = await fetch(apiUrl, { headers: { 'User-Agent': UA } });
    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Data titles length:', data?.message?.body?.titles?.length);
    if (data?.message?.body?.titles?.[0]?.titleId) {
      return data.message.body.titles[0].titleId;
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
  return null;
}
tryCdpApi('B0DWSGK5GS', 'amazon.co.uk', 1, 3).then(console.log);
