const https = require('https');
const fs = require('fs');

const cookieStr = fs.readFileSync('cookies.txt', 'utf8')
  .split('\n')
  .filter(l => l.includes('.instagram.com'))
  .map(l => {
    const p = l.split('\t');
    if (p.length >= 7) {
        let val = p[6].replace(/[\r\n]/g, '');
        // simple encoding for cookie values that might have invalid chars
        if (val.includes('"') || val.includes('\\')) {
            val = encodeURIComponent(val);
        }
        return p[5] + '=' + val;
    }
    return '';
  })
  .filter(Boolean)
  .join('; ');

const shortcode = 'DYuCXigkod3';
const queryHash = 'b3055c01b4b222b8a47dc12b090e4e64';
const variables = encodeURIComponent(JSON.stringify({ shortcode, child_comment_count: 3, fetch_comment_count: 40, parent_comment_count: 24, has_threaded_comments: true }));

const url = `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${variables}`;

https.get(url, {
  headers: {
    'Cookie': cookieStr,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-IG-App-ID': '936619743392459',
    'Accept': '*/*'
  }
}, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
      console.log('Status:', res.statusCode);
      try {
          const data = JSON.parse(body);
          if (data.data && data.data.shortcode_media) {
             const media = data.data.shortcode_media;
             console.log('Found media:', media.shortcode);
             if (media.edge_sidecar_to_children) {
                 const children = media.edge_sidecar_to_children.edges;
                 console.log('Carousel items:', children.length);
                 children.forEach((c, i) => {
                     console.log(`Item ${i+1}: ${c.node.display_url.substring(0,50)}...`);
                 });
             } else {
                 console.log('Single image:', media.display_url.substring(0,50));
             }
          } else {
             console.log('Unexpected JSON:', body.substring(0, 200));
          }
      } catch (e) {
          console.error('Failed to parse JSON. Raw body snippet:', body.substring(0, 300));
      }
  });
}).on('error', console.error);
