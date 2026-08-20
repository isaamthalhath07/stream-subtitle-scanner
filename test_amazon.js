const https = require('https');

https.get('https://www.amazon.co.uk/gp/video/detail/B0DWSGK5GS/', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  }
}, (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400) {
    console.log('Redirected to:', res.headers.location);
    return;
  }
  let body='';
  res.on('data', c=>body+=c);
  res.on('end', () => {
    console.log('Length:', body.length);
    const apis = body.match(/https:\/\/[^\/]+\/(?:api|graphql)[^\"']+/g);
    console.log('APIs found:', apis ? [...new Set(apis)] : 'None');
    
    // Check for GraphQL queries or operations in the page
    const gqlMatches = body.match(/\"queryId\":\"[^\"]+\"/g);
    console.log('GraphQL Queries:', gqlMatches ? [...new Set(gqlMatches)] : 'None');

    const state = body.match(/window\.__ATVWebPlayerData__\s*=\s*({[\s\S]*?});?\s*<\/script>/i);
    console.log('Has ATVWebPlayerData:', !!state);
    
    // Let's also look for other state blobs
    const state2 = body.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i);
    console.log('Has __PRELOADED_STATE__:', !!state2);
    
    const pageData = body.match(/<script type=\"application\/json\" id=\"av-page-info\">/i);
    console.log('Has av-page-info:', !!pageData);
  });
}).on('error', console.error);
