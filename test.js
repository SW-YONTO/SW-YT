const path = require('path');
const fs = require('fs');

const relativePath = 'node_modules/youtube-dl-exec/bin/yt-dlp.exe';
console.log('Binary exists at relative path:', fs.existsSync(relativePath));

const { create } = require('youtube-dl-exec');
// Create custom instance using relative path
const youtubeDl = create(relativePath);

(async () => {
  try {
    const output = await youtubeDl('https://www.instagram.com/reel/DWGTUEvDlx5/?utm_source=ig_web_copy_link&igsh=NTc4MTIwNjQ2YQ==', {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    console.log("SUCCESS:", output.title || output.id);
  } catch (e) {
    console.error("FAIL:", e.message);
  }
})();
