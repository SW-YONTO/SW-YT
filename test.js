const youtubeDl = require('youtube-dl-exec');

(async () => {
  try {
    const output = await youtubeDl('https://youtu.be/vfSjxPtnX-k', {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      extractorArgs: 'youtube:player_client=android'
    });
    console.log("SUCCESS with android client:", output.title);
  } catch (e) {
    console.error("FAIL with android:", e.message);
  }
})();
