const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { create } = require('youtube-dl-exec');
const ytpl = require('ytpl');
const ffmpegPath = require('ffmpeg-static');
const relativeFfmpegPath = path.relative(process.cwd(), ffmpegPath);
require('dotenv').config();

// Use system yt-dlp binary if set (Railway production), otherwise use bundled.
// On Windows, resolve the bundled binary to a relative path to avoid spaces-in-path shell command injection.
const defaultBinaryPath = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const relativeDefaultPath = path.relative(process.cwd(), defaultBinaryPath);

const youtubeDl = process.env.YOUTUBE_DL_PATH
  ? create(process.env.YOUTUBE_DL_PATH)
  : create(relativeDefaultPath);

const app = express();
const PORT = process.env.PORT || 3000;

// Set up directories
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Background Cleanup Task: Runs every 5 minutes
setInterval(() => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const now = Date.now();
    const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes buffer time
    let deletedCount = 0;

    files.forEach(file => {
      const filePath = path.join(DOWNLOADS_DIR, file);
      const stats = fs.statSync(filePath);
      // If file is older than 10 minutes, delete it
      if (now - stats.mtime.getTime() > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    });

    if (deletedCount > 0) {
      console.log(`[Cleanup] Auto-deleted ${deletedCount} old files from downloads folder.`);
    }
  } catch (err) {
    console.error('[Cleanup] Background cleanup task failed:', err.message);
  }
}, 5 * 60 * 1000); // 5 minutes interval

// Write YouTube cookies from environment variable to a file (for production bot bypass)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const envCookies = process.env.COOKIES_CONTENT || process.env.YOUTUBE_COOKIES;

if (envCookies) {
  // Railway stores multi-line env vars with literal \n — convert back to real newlines
  const cookiesContent = envCookies.replace(/\\n/g, '\n');
  fs.writeFileSync(COOKIES_FILE, cookiesContent, 'utf8');
  console.log('[Cookies] YouTube cookies loaded from environment variable.');
  console.log('[Cookies] File size:', fs.statSync(COOKIES_FILE).size, 'bytes');
  console.log('[Cookies] First line:', cookiesContent.split('\n')[0]);
} else if (fs.existsSync(COOKIES_FILE)) {
  console.log('[Cookies] Local cookies.txt found. Using local file.');
} else {
  console.log('[Cookies] No YouTube cookies found in environment or local cookies.txt. Running without cookies.')
}

// Write Instagram cookies from environment variable to a separate file
// On Railway: set INSTAGRAM_COOKIES env var with the contents of instagram.com_cookies.txt
const IG_COOKIES_FILE = path.join(__dirname, 'instagram_cookies.txt');
const envIgCookies = process.env.INSTAGRAM_COOKIES;

if (envIgCookies) {
  // Railway stores multi-line env vars with literal \n — convert back to real newlines
  const igCookiesContent = envIgCookies.replace(/\\n/g, '\n');
  fs.writeFileSync(IG_COOKIES_FILE, igCookiesContent, 'utf8');
  console.log('[IG Cookies] Instagram cookies loaded from environment variable.');
  console.log('[IG Cookies] File size:', fs.statSync(IG_COOKIES_FILE).size, 'bytes');
} else if (fs.existsSync(path.join(__dirname, 'instagram.com_cookies.txt'))) {
  // Local dev: use the instagram.com_cookies.txt file directly
  fs.copyFileSync(path.join(__dirname, 'instagram.com_cookies.txt'), IG_COOKIES_FILE);
  console.log('[IG Cookies] Local instagram.com_cookies.txt found. Copied to instagram_cookies.txt.');
} else {
  console.log('[IG Cookies] No Instagram cookies found. Instagram downloads may fail with 401.')
}

console.log('[Config] YOUTUBE_DL_PATH =', process.env.YOUTUBE_DL_PATH || '(not set - using bundled)');
console.log('[Config] YT Cookies file exists:', fs.existsSync(COOKIES_FILE));
console.log('[Config] IG Cookies file exists:', fs.existsSync(IG_COOKIES_FILE));
console.log('[Config] NODE_ENV =', process.env.NODE_ENV || 'not set');

// Safe relative paths for yt-dlp to avoid space-in-path errors on Windows
const relativeCookiesPath = path.relative(process.cwd(), COOKIES_FILE);
const relativeIgCookiesPath = path.relative(process.cwd(), IG_COOKIES_FILE);

// Express configs
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files — add no-cache for JS/CSS so browsers always revalidate
// This prevents stale main.js from running after a Railway redeploy
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Build version = server start time (changes every Railway redeploy)
const BUILD_VERSION = Date.now().toString(36);

// Shared in-memory active downloads store
const activeDownloads = {};
const clients = [];

// Broadcast progress updates to SSE clients
function notifyClients(downloadId) {
  const data = JSON.stringify({
    type: 'update',
    downloadId,
    job: activeDownloads[downloadId]
  });
  clients.forEach(c => {
    try {
      c.res.write(`data: ${data}\n\n`);
    } catch (e) {
      console.error('SSE Write Error:', e);
    }
  });
}

// Helper to strip YouTube Mix playlist parameters from URLs to avoid hanging on playlist metadata fetches
function cleanYoutubeUrl(urlStr) {
  if (!urlStr) return urlStr;
  try {
    if (urlStr.includes('youtube.com') || urlStr.includes('youtu.be')) {
      const parsedUrl = new URL(urlStr);
      const listParam = parsedUrl.searchParams.get('list');
      if (listParam && listParam.startsWith('RD')) {
        parsedUrl.searchParams.delete('list');
        parsedUrl.searchParams.delete('start_radio');
        return parsedUrl.toString();
      }
    }
  } catch (e) {
    console.error('[URL Cleaner] Failed to clean URL:', e.message);
  }
  return urlStr;
}

// ----------------- ROUTES -----------------

// Diagnostic debug endpoint (safe read-only info)
app.get('/api/debug', async (req, res) => {
  const { execSync } = require('child_process');
  let ytdlpVersion = 'unknown';
  let systemYtdlpVersion = 'unknown';
  try { ytdlpVersion = execSync(`"${process.env.YOUTUBE_DL_PATH || 'yt-dlp'}" --version 2>&1`).toString().trim(); } catch (e) { ytdlpVersion = e.message; }
  try { systemYtdlpVersion = execSync('yt-dlp --version 2>&1').toString().trim(); } catch (e) { systemYtdlpVersion = 'not found in PATH'; }

  // Read first meaningful (non-comment) cookie line from IG file for preview
  let igCookiePreview = 'N/A';
  if (fs.existsSync(IG_COOKIES_FILE)) {
    const lines = fs.readFileSync(IG_COOKIES_FILE, 'utf8').split('\n');
    const firstCookie = lines.find(l => l.trim() && !l.startsWith('#'));
    if (firstCookie) {
      const parts = firstCookie.split('\t');
      // Show domain + cookie name only — never expose cookie value
      igCookiePreview = `domain=${parts[0]}, name=${parts[5] || '?'}`;
    }
  }

  // Same for YouTube cookies
  let ytCookiePreview = 'N/A';
  if (fs.existsSync(COOKIES_FILE)) {
    const lines = fs.readFileSync(COOKIES_FILE, 'utf8').split('\n');
    const firstCookie = lines.find(l => l.trim() && !l.startsWith('#'));
    if (firstCookie) {
      const parts = firstCookie.split('\t');
      ytCookiePreview = `domain=${parts[0]}, name=${parts[5] || '?'}`;
    }
  }

  res.json({
    // ---- yt-dlp binary ----
    YOUTUBE_DL_PATH: process.env.YOUTUBE_DL_PATH || '(not set)',
    bundled_ytdlp_version: ytdlpVersion,
    system_ytdlp_version: systemYtdlpVersion,

    // ---- YouTube cookies ----
    youtube_cookies_env_set: !!(process.env.COOKIES_CONTENT || process.env.YOUTUBE_COOKIES),
    youtube_cookies_file_exists: fs.existsSync(COOKIES_FILE),
    youtube_cookies_file_size: fs.existsSync(COOKIES_FILE) ? fs.statSync(COOKIES_FILE).size + ' bytes' : '0 bytes',
    youtube_cookies_preview: ytCookiePreview,

    // ---- Instagram cookies ----
    instagram_cookies_env_set: !!process.env.INSTAGRAM_COOKIES,
    instagram_cookies_file_exists: fs.existsSync(IG_COOKIES_FILE),
    instagram_cookies_file_size: fs.existsSync(IG_COOKIES_FILE) ? fs.statSync(IG_COOKIES_FILE).size + ' bytes' : '0 bytes',
    instagram_cookies_preview: igCookiePreview,

    // ---- runtime ----
    node_version: process.version,
    platform: process.platform,
  });
});


// Check all files in downloads folder
app.get('/api/downloads/status', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    res.json({
      count: files.length,
      files: files
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// Delete all files in downloads folder
app.get('/api/downloads/all', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    let deletedCount = 0;
    files.forEach(file => {
      fs.unlinkSync(path.join(DOWNLOADS_DIR, file));
      deletedCount++;
    });
    res.json({ success: true, deletedCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete files' });
  }
});

// Advanced yt-dlp diagnosis endpoint
app.get('/api/test-ytdlp', async (req, res) => {
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);

  const url = req.query.url || 'https://youtu.be/TCv8V-zsfRM';
  const ytdlpPath = process.env.YOUTUBE_DL_PATH || 'yt-dlp';
  const cookiesStr = fs.existsSync(COOKIES_FILE) ? `--cookies "${relativeCookiesPath}"` : '';

  const tests = [
    { name: '5. No Cookies, Android Client', cmd: `"${ytdlpPath}" -j --skip-download --extractor-args "youtube:player_client=android" "${url}"` },
    { name: '6. No Cookies, iOS Client', cmd: `"${ytdlpPath}" -j --skip-download --extractor-args "youtube:player_client=ios" "${url}"` },
    { name: '7. No Cookies, TV Client', cmd: `"${ytdlpPath}" -j --skip-download --extractor-args "youtube:player_client=tv" "${url}"` },
    { name: '8. With Cookies, Force IPv4', cmd: `"${ytdlpPath}" -j --skip-download --force-ipv4 ${cookiesStr} "${url}"` },
    { name: '9. With Cookies, Force IPv6', cmd: `"${ytdlpPath}" -j --skip-download --force-ipv6 ${cookiesStr} "${url}"` },
    { name: '10. With Cookies, Node JS Runtime', cmd: `"${ytdlpPath}" -j --skip-download --js-runtimes node ${cookiesStr} "${url}"` }
  ];

  let results = [];

  for (const test of tests) {
    try {
      const { stdout, stderr } = await execPromise(test.cmd, { timeout: 15000 });
      results.push({
        test: test.name,
        success: true,
        cmd: test.cmd,
        stderr: stderr.trim(),
        stdoutSnippet: stdout ? stdout.substring(0, 150) + '...' : 'empty'
      });
    } catch (err) {
      results.push({
        test: test.name,
        success: false,
        cmd: test.cmd,
        error: err.message,
        stderr: err.stderr ? err.stderr.trim() : ''
      });
    }
  }

  res.json({
    targetUrl: url,
    binary: ytdlpPath,
    cookiesPresent: fs.existsSync(COOKIES_FILE),
    results
  });
});

// Home Dashboard Route
app.get('/', (req, res) => {
  res.render('index', { buildVersion: BUILD_VERSION });
});

// Single Video or Playlist Metadata Extractor
app.get('/api/info', async (req, res) => {
  let { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL query parameter is required.' });
  }

  // Clean YouTube Mix URLs to extract them as a single video instead of dynamic playlist
  url = cleanYoutubeUrl(url);

  // Helper check for playlist ID / list parameter
  const hasPlaylist = url.includes('list=') || ytpl.validateID(url);

  if (hasPlaylist) {
    try {
      // Fetch playlist using ytpl
      const playlist = await ytpl(url, { limit: Infinity });
      return res.json({
        isPlaylist: true,
        id: playlist.id,
        title: playlist.title,
        author: playlist.author ? playlist.author.name : 'Unknown Author',
        videoCount: playlist.items.length,
        thumbnail: playlist.items[0]?.bestThumbnail?.url || '',
        items: playlist.items.map(item => ({
          id: item.id,
          title: item.title,
          url: item.shortUrl,
          duration: item.duration,
          thumbnail: item.bestThumbnail?.url || ''
        }))
      });
    } catch (playlistErr) {
      console.log('Not a valid playlist or failed to load via ytpl, trying single video...');
    }
  }

  // Fallback / standard route: fetch single video details using youtube-dl-exec
  try {
    const cookiesExist = fs.existsSync(COOKIES_FILE);
    console.log(`[Info] Fetching info for: ${url}`);
    console.log(`[Info] Cookies file present: ${cookiesExist}`);
    
    const isInstagram = url.includes('instagram.com');
    const isInstaPost = isInstagram && url.includes('/p/');
    const isInstaReel = isInstagram && url.includes('/reel/');
    
    // --- Instagram Pre-Processor ---
    // For ALL Instagram links, try instagram-url-direct first
    if (isInstagram) {
      // Helper: wrap instagramGetUrl with a 10-second timeout
      const fetchWithTimeout = (fetchUrl, timeoutMs = 10000) => {
        const { instagramGetUrl } = require('instagram-url-direct');
        return Promise.race([
          instagramGetUrl(fetchUrl),
          new Promise((_, reject) => setTimeout(() => reject(new Error('IG Scraper timed out')), timeoutMs))
        ]);
      };

      try {
        const igData = await fetchWithTimeout(url);
        
        if (igData && igData.url_list && igData.url_list.length > 0) {
          // For /p/ posts: ALWAYS return as image carousel (even if 1 image)
          if (isInstaPost) {
            return res.json({
              isPlaylist: true,
              isImageCarousel: true,
              id: (igData.post_info?.owner_username || 'ig') + '_' + Date.now(),
              title: igData.post_info?.caption?.substring(0, 40) || 'Instagram Post',
              author: igData.post_info?.owner_username || 'Instagram',
              videoCount: igData.results_number,
              thumbnail: igData.url_list[0],
              items: igData.url_list.map((mediaUrl, idx) => ({
                id: 'ig_' + idx,
                title: `Image ${idx + 1}`,
                url: mediaUrl,
                duration: 0,
                thumbnail: mediaUrl
              }))
            });
          }
          // For /reel/ URLs: fall through to yt-dlp for proper video quality
        }
      } catch (igErr) {
        console.error('[Info] IG Scraper early fetch failed:', igErr.message);
        
        // For /p/ posts: if IG scraper fails, try yt-dlp to extract image URLs
        if (isInstaPost) {
          try {
            console.log('[Info] Trying yt-dlp fallback for Instagram post images...');
            const igCookiesExist = fs.existsSync(IG_COOKIES_FILE);
            const igOutput = await youtubeDl(url, {
              dumpSingleJson: true,
              noWarnings: true,
              noCheckCertificates: true,
              skipDownload: true,
              noCheckFormats: true,
              jsRuntimes: 'node',
              addHeader: [
                'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept-Language:en-US,en;q=0.9'
              ],
              ...(igCookiesExist ? { cookies: relativeIgCookiesPath } : {})
            });
            
            // yt-dlp returns image URLs in the thumbnails array for image posts
            const imageUrls = (igOutput.thumbnails || [])
              .filter(t => t.url && (t.url.includes('scontent') || t.url.includes('.fbcdn.net')))
              .map(t => t.url);
            
            if (imageUrls.length > 0) {
              return res.json({
                isPlaylist: true,
                isImageCarousel: true,
                id: (igOutput.uploader || 'ig') + '_' + Date.now(),
                title: igOutput.title || igOutput.description?.substring(0, 40) || 'Instagram Post',
                author: igOutput.uploader || 'Instagram',
                videoCount: imageUrls.length,
                thumbnail: imageUrls[0],
                items: imageUrls.map((imgUrl, idx) => ({
                  id: 'ig_' + idx,
                  title: `Image ${idx + 1}`,
                  url: imgUrl,
                  duration: 0,
                  thumbnail: imgUrl
                }))
              });
            }
          } catch (ytdlpErr) {
            console.error('[Info] yt-dlp fallback for IG post also failed:', ytdlpErr.message);
          }
          
          return res.status(500).json({ 
            error: 'Instagram is temporarily blocking this server. Please try again in a few minutes.' 
          });
        }
        // For /reel/ URLs, fall through to yt-dlp below
      }
    }
    
    console.log(`[Info] Using binary: ${process.env.YOUTUBE_DL_PATH || 'bundled'}`);
    const igCookiesExist = fs.existsSync(IG_COOKIES_FILE);
    const infoOptions = {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      skipDownload: true,
      noCheckFormats: true,
      flatPlaylist: true,
      jsRuntimes: 'node',
    };

    if (isInstagram) {
      // Instagram: use IG-specific cookies and mobile user-agent to avoid 401
      if (igCookiesExist) infoOptions.cookies = relativeIgCookiesPath;
      infoOptions.addHeader = [
        'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language:en-US,en;q=0.9'
      ];
      // Avoid hammering Instagram with rapid requests (prevents 401/429)
      infoOptions.sleepRequests = 1;
    } else {
      // YouTube and others: use YouTube cookies
      if (cookiesExist) infoOptions.cookies = relativeCookiesPath;
    }

    const output = await youtubeDl(url, infoOptions);

    if (output._type === 'playlist' || output.entries) {
      return res.json({
        isPlaylist: true,
        id: output.id,
        title: output.title || 'Playlist',
        author: output.uploader || output.channel || 'Unknown',
        videoCount: output.entries ? output.entries.length : 0,
        thumbnail: output.thumbnails && output.thumbnails.length > 0 ? output.thumbnails[0].url : '',
        items: (output.entries || []).map(item => ({
          id: item.id,
          title: item.title,
          url: item.url || item.webpage_url || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : url),
          duration: item.duration || 0,
          thumbnail: item.thumbnails && item.thumbnails.length > 0 ? item.thumbnails[0].url : ''
        }))
      });
    }

    return res.json({
      isPlaylist: false,
      id: output.id,
      title: output.title,
      duration: output.duration,
      thumbnail: output.thumbnail,
      channel: output.uploader || output.channel || 'Unknown',
      views: output.view_count || 0
    });
  } catch (err) {
    console.error('[Info] Error fetching video info:', err.message);
    
    // Better error messages for Instagram
    if (url.includes('instagram.com')) {
      return res.status(500).json({ 
        error: 'Instagram is temporarily blocking this server. Please try again in a few minutes.' 
      });
    }
    
    return res.status(500).json({ error: 'Failed to extract video details: ' + err.message });
  }
});

// Image Proxy Route to bypass CORS/CORP issues (e.g., Instagram thumbnails)
app.get('/api/proxy-image', (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('URL required');

  const client = imageUrl.startsWith('https') ? https : http;

  client.get(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  }, (proxyRes) => {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      return res.redirect(`/api/proxy-image?url=${encodeURIComponent(proxyRes.headers.location)}`);
    }

    const headers = {};
    if (proxyRes.headers['content-type']) headers['Content-Type'] = proxyRes.headers['content-type'];
    if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
    headers['Cache-Control'] = 'public, max-age=86400';

    res.writeHead(proxyRes.statusCode || 200, headers);
    proxyRes.pipe(res, { end: true });
  }).on('error', (err) => {
    console.error('[Proxy] Image proxy failed:', err.message);
    res.redirect('https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&auto=format&fit=crop');
  });
});

// Server-Sent Events (SSE) Endpoint for Progress Updates
app.get('/api/download/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Assign a unique ID to this browser tab/connection
  const clientId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);

  // Send the clientId to the browser immediately so it knows who it is
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  // Filter in-memory downloads to only broadcast ongoing (pending/downloading) jobs on new load/refresh
  const ongoingDownloads = {};
  for (const [id, job] of Object.entries(activeDownloads)) {
    if (job.status === 'downloading' || job.status === 'pending') {
      ongoingDownloads[id] = job;
    }
  }

  // Send current ongoing jobs state
  res.write(`data: ${JSON.stringify({ type: 'init', downloads: ongoingDownloads })}\n\n`);

  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on('close', () => {
    const index = clients.findIndex(c => c.id === clientId);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });
});

// --- Helper for Direct Image Downloads ---
function downloadDirectImage(url, title, downloadId) {
  const safeTitle = (title || 'image').replace(/[^\w\s-]/g, '').trim().substring(0, 50);
  const filePath = path.join(DOWNLOADS_DIR, `${safeTitle}_${downloadId.substring(downloadId.length-4)}.jpg`);
  
  activeDownloads[downloadId].status = 'downloading';
  activeDownloads[downloadId].progress = '0%';
  notifyClients(downloadId);

  const client = url.startsWith('https') ? https : http;
  
  client.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
       return downloadDirectImage(res.headers.location, title, downloadId);
    }
    if (res.statusCode !== 200) {
      activeDownloads[downloadId].status = 'error';
      activeDownloads[downloadId].error = `HTTP Error: ${res.statusCode}`;
      notifyClients(downloadId);
      return;
    }

    const fileStream = fs.createWriteStream(filePath);
    const totalSize = parseInt(res.headers['content-length'] || '0', 10);
    let downloadedSize = 0;

    res.pipe(fileStream);

    res.on('data', (chunk) => {
      downloadedSize += chunk.length;
      if (totalSize) {
        const percent = Math.round((downloadedSize / totalSize) * 100);
        activeDownloads[downloadId].progress = `${percent}%`;
        notifyClients(downloadId);
      }
    });

    fileStream.on('finish', () => {
      fileStream.close();
      activeDownloads[downloadId].status = 'completed';
      activeDownloads[downloadId].progress = '100%';
      activeDownloads[downloadId].percent = 100;
      activeDownloads[downloadId].filename = path.basename(filePath);                          // ← FIXED: frontend reads .filename to trigger browser download
      activeDownloads[downloadId].downloadUrl = `/api/download/file/${path.basename(filePath)}`;
      notifyClients(downloadId);
    });
  }).on('error', (err) => {
    fs.unlink(filePath, () => {});
    activeDownloads[downloadId].status = 'error';
    activeDownloads[downloadId].error = err.message;
    notifyClients(downloadId);
  });
}

// Start Server-Side Download Job
app.post('/api/download/server', (req, res) => {
  let { url, format, title, id, ownerClientId } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  url = cleanYoutubeUrl(url);

  const downloadId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);

  // Set up details in memory
  // ownerClientId tags which browser tab started this download — only THAT tab
  // will receive the browser file push; other tabs just see the progress card.
  activeDownloads[downloadId] = {
    title: title || 'Extracting title...',
    url,
    percent: 0,
    size: '0MB',
    speed: '0KB/s',
    eta: '--:--',
    status: 'pending',
    filename: null,
    cp: null,
    ownerClientId: ownerClientId || null
  };

  // Bandwidth optimization 2: Check if there is already an ACTIVE download running for this same URL and format!
  const duplicateActiveJob = Object.values(activeDownloads).find(job => {
    return job.url === url && 
           job.format === format && 
           (job.status === 'downloading' || job.status === 'pending');
  });

  if (duplicateActiveJob) {
    console.log(`[Parallel Cache Hit] Linking duplicate request to active download: ${duplicateActiveJob.title}`);
    
    // Copy current state of active job to this new job
    activeDownloads[downloadId].status = duplicateActiveJob.status;
    activeDownloads[downloadId].percent = duplicateActiveJob.percent;
    activeDownloads[downloadId].size = duplicateActiveJob.size;
    activeDownloads[downloadId].speed = duplicateActiveJob.speed;
    activeDownloads[downloadId].eta = duplicateActiveJob.eta;
    activeDownloads[downloadId].filename = duplicateActiveJob.filename;
    
    notifyClients(downloadId);
    return res.json({ success: true, downloadId });
  }

  // Fast-path direct downloader for images
  if (format === 'image' || url.includes('.fna.fbcdn.net') || url.includes('scontent')) {
    downloadDirectImage(url, title || `Image_${downloadId}`, downloadId);
    return res.json({ success: true, downloadId });
  }

  res.json({ success: true, downloadId });

  // Bandwidth optimization: Check if a matching completed file already exists on the server!
  let cachedFile = null;
  if (id) {
    try {
      const expectedExts = format === 'mp3' 
        ? ['.mp3', '.m4a'] 
        : ['.mp4', '.webm', '.mkv', '.3gp'];
      const files = fs.readdirSync(DOWNLOADS_DIR);
      
      // Look for a completed file that matches our unique video ID and expected extension
      const match = files.find(f => {
        return f.includes(`_${id}_`) && 
               expectedExts.some(ext => f.endsWith(ext)) && 
               !f.endsWith('.part') && 
               !f.endsWith('.ytdl');
      });
      if (match) {
        cachedFile = path.join(DOWNLOADS_DIR, match);
        console.log(`[Cache Hit] Found existing file for optimization: ${match}`);
      }
    } catch (e) {
      console.error('[Cache Check] Failed to check for existing file:', e.message);
    }
  }

  if (cachedFile) {
    const matchedFilename = path.basename(cachedFile);
    
    // Simulate a fast-path progress download for a satisfying visual UX
    activeDownloads[downloadId].status = 'downloading';
    activeDownloads[downloadId].filename = matchedFilename; // Reuse the existing file directly!
    notifyClients(downloadId);
    
    let percent = 0;
    const interval = setInterval(() => {
      percent += 25;
      if (percent >= 100) {
        clearInterval(interval);
        activeDownloads[downloadId].percent = 100;
        activeDownloads[downloadId].status = 'completed';
        activeDownloads[downloadId].speed = 'Instant (Cache)';
        activeDownloads[downloadId].eta = '00:00';
        notifyClients(downloadId);
        
        // Memory cleanup: remove completed job from cache after 10 seconds
        setTimeout(() => {
          if (activeDownloads[downloadId]) {
            delete activeDownloads[downloadId];
          }
        }, 10000);
      } else {
        activeDownloads[downloadId].percent = percent;
        activeDownloads[downloadId].speed = 'Instant (Cache)';
        activeDownloads[downloadId].eta = '00:00';
        notifyClients(downloadId);
      }
    }, 200);
    
    return;
  }

  // Self-healing download function
  const runDownload = (isRetry = false) => {
    const isInstagramUrl = url.includes('instagram.com');
    const igCookiesExist = fs.existsSync(IG_COOKIES_FILE);

    const options = {
      output: `downloads/%(title)s_%(id)s_${downloadId}.%(ext)s`,
      noWarnings: true,
      ffmpegLocation: relativeFfmpegPath,
      jsRuntimes: 'node',
    };

    if (isInstagramUrl) {
      // Instagram: use IG-specific cookies and mobile user-agent to bypass 401
      if (igCookiesExist) options.cookies = relativeIgCookiesPath;
      options.addHeader = [
        'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language:en-US,en;q=0.9'
      ];
      // Throttle requests to Instagram to avoid 401/429 bans
      options.sleepRequests = 2;
      options.noCheckCertificates = true;
    } else {
      // YouTube and others: use YouTube cookies
      if (fs.existsSync(COOKIES_FILE)) options.cookies = relativeCookiesPath;
    }

    if (format === 'mp3') {
      if (isRetry) {
        // Fallback: download raw audio stream (m4a) without post-processing conversion
        options.format = 'bestaudio[ext=m4a]/bestaudio';
      } else {
        options.extractAudio = true;
        options.audioFormat = 'mp3';
        options.audioQuality = '0';
        options.format = 'bestaudio/best';
      }
    } else if (format === '720p') {
      if (isRetry) {
        options.format = 'best[height<=720]/best';
      } else {
        // Prefer YouTube's native MP4 format to avoid webm/mkv containers and merge instantly
        options.format = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best';
      }
    } else if (isInstagramUrl) {
      // Instagram serves single combined streams — never use bestvideo+bestaudio
      options.format = 'best';
    } else {
      if (isRetry) {
        // Fallback: download highest pre-merged single video file (no ffmpeg merging required)
        options.format = 'best';
      } else {
        // Prefer YouTube's native MP4 format to avoid webm/mkv containers and merge instantly
        options.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
      }
    }

    // Force ffmpeg to merge streams into a 100% compliant MP4 container (for iOS/Safari compatibility)
    if (format !== 'mp3' && !isInstagramUrl) {
      options.mergeOutputFormat = 'mp4';
    }

    const cp = youtubeDl.exec(url, options, {
      env: { ...process.env, YOUTUBE_DL_SKIP_PYTHON_CHECK: '1' }
    });

    activeDownloads[downloadId].cp = cp;
    activeDownloads[downloadId].status = 'downloading';
    notifyClients(downloadId);

    // Parse stdout for progress updates
    cp.stdout.on('data', data => {
      if (!activeDownloads[downloadId]) return;
      const line = data.toString();

      // Check for progress line: [download]  12.4% of 34.20MiB at  2.40MiB/s ETA 00:15
      const progressMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/);
      if (progressMatch) {
        activeDownloads[downloadId].percent = parseFloat(progressMatch[1]);
        activeDownloads[downloadId].size = progressMatch[2];
        activeDownloads[downloadId].speed = progressMatch[3];
        activeDownloads[downloadId].eta = progressMatch[4];
        activeDownloads[downloadId].status = 'downloading';
        notifyClients(downloadId);

        // Sync progress to all other parallel duplicate jobs
        Object.entries(activeDownloads).forEach(([id, job]) => {
          if (id !== downloadId && job.url === url && job.format === format && job.status !== 'completed' && job.status !== 'error' && job.status !== 'cancelled') {
            job.percent = activeDownloads[downloadId].percent;
            job.size = activeDownloads[downloadId].size;
            job.speed = activeDownloads[downloadId].speed;
            job.eta = activeDownloads[downloadId].eta;
            job.status = 'downloading';
            notifyClients(id);
          }
        });
      }

      // Check for filename destinations
      const destMatch = line.match(/\[download\] Destination: (.+)/) ||
        line.match(/\[Merging formats into "(.+)"\]/) ||
        line.match(/\[ffmpeg\] Destination: (.+)/) ||
        line.match(/\[ExtractAudio\] Destination: (.+)/) ||
        line.match(/\[FixupM3u8\] Destination: (.+)/);
      if (destMatch) {
        const filePath = destMatch[1];
        activeDownloads[downloadId].filename = path.basename(filePath);

        // Sync filename to all duplicate jobs
        Object.entries(activeDownloads).forEach(([id, job]) => {
          if (id !== downloadId && job.url === url && job.format === format && job.status !== 'completed' && job.status !== 'error' && job.status !== 'cancelled') {
            job.filename = activeDownloads[downloadId].filename;
          }
        });
      }
    });

    cp.then(() => {
      if (!activeDownloads[downloadId]) return;
      activeDownloads[downloadId].percent = 100;
      activeDownloads[downloadId].status = 'completed';
      activeDownloads[downloadId].speed = '--';
      activeDownloads[downloadId].eta = '00:00';

      if (activeDownloads[downloadId].filename) {
        // Ensure the file actually exists, it might have been replaced (e.g. m4a -> mp3)
        const checkPath = path.join(DOWNLOADS_DIR, activeDownloads[downloadId].filename);
        if (!fs.existsSync(checkPath)) {
          activeDownloads[downloadId].filename = null; // force fallback
        }
      }

      // Double check if filename wasn't captured or was cleared, check download directory
      if (!activeDownloads[downloadId].filename) {
        try {
          const files = fs.readdirSync(DOWNLOADS_DIR);
          // Find the unique file containing our downloadId suffix!
          const matchingFile = files.find(f => f.includes(`_${downloadId}`) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
          if (matchingFile) {
            activeDownloads[downloadId].filename = matchingFile;
          } else {
            // Fallback: Find most recently modified file in case of custom naming
            const newest = files
              .filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'))
              .map(file => ({ file, time: fs.statSync(path.join(DOWNLOADS_DIR, file)).mtime.getTime() }))
              .sort((a, b) => b.time - a.time)[0];
            if (newest) {
              activeDownloads[downloadId].filename = newest.file;
            }
          }
        } catch (err) {
          console.error('Fallback directory check failed:', err);
        }
      }
      notifyClients(downloadId);

      // Synchronize completion to all other parallel duplicate jobs!
      Object.entries(activeDownloads).forEach(([id, job]) => {
        if (id !== downloadId && job.url === url && job.format === format && job.status !== 'completed' && job.status !== 'error' && job.status !== 'cancelled') {
          job.percent = 100;
          job.status = 'completed';
          job.speed = '--';
          job.eta = '00:00';
          job.filename = activeDownloads[downloadId].filename;
          notifyClients(id);
          
          setTimeout(() => {
            if (activeDownloads[id]) delete activeDownloads[id];
          }, 10000);
        }
      });

      // Memory cleanup: remove completed job from cache after 10 seconds
      setTimeout(() => {
        if (activeDownloads[downloadId]) {
          delete activeDownloads[downloadId];
        }
      }, 10000);
    }).catch(err => {
      if (!activeDownloads[downloadId]) return;
      
      // If job was manually cancelled, ignore any subprocess exit errors
      if (activeDownloads[downloadId].status === 'cancelled') return;

      // PRINT ERROR LOG ON SERVER CONSOLE WITH MAXIMUM DETAILS
      console.error(`\n[DOWNLOAD ERROR] Download Job Failed! (ID: ${downloadId}, Title: ${title || 'unknown'})`);
      if (err.stderr) {
        console.error(`stderr: ${err.stderr}`);
      }
      console.error(`message: ${err.message}\n`);

      const isFfmpegError = (err.stderr || '').includes('ffmpeg not found') ||
        (err.stderr || '').includes('ffprobe not found') ||
        (err.stderr || '').includes('ffprobe or avprobe not found');

      if (isFfmpegError && !isRetry) {
        console.warn(`[DOWNLOAD WARNING] ffmpeg/ffprobe not found on host system.`);
        console.warn(`[DOWNLOAD FALLBACK] Retrying download job ${downloadId} with raw/pre-merged stream formats...`);
        activeDownloads[downloadId].status = 'pending';
        notifyClients(downloadId);
        runDownload(true); // Run retry fallback
      } else {
        activeDownloads[downloadId].status = 'error';
        activeDownloads[downloadId].error = err.stderr || err.message;
        notifyClients(downloadId);

        // Synchronize failure to all other parallel duplicate jobs!
        Object.entries(activeDownloads).forEach(([id, job]) => {
          if (id !== downloadId && job.url === url && job.format === format && job.status !== 'completed' && job.status !== 'error' && job.status !== 'cancelled') {
            job.status = 'error';
            job.error = activeDownloads[downloadId].error;
            notifyClients(id);
            
            setTimeout(() => {
              if (activeDownloads[id]) delete activeDownloads[id];
            }, 10000);
          }
        });

        // Memory cleanup: remove failed job from cache after 10 seconds so it doesn't linger
        setTimeout(() => {
          if (activeDownloads[downloadId]) {
            delete activeDownloads[downloadId];
          }
        }, 10000);
      }
    });
  };

  runDownload();
});

// Cancel Download Endpoint
app.post('/api/download/cancel', (req, res) => {
  const { downloadId } = req.body;
  if (!downloadId || !activeDownloads[downloadId]) {
    return res.status(404).json({ error: 'Download not found' });
  }

  const job = activeDownloads[downloadId];
  if (job.status === 'downloading' || job.status === 'pending') {
    if (job.cp) {
      try { job.cp.kill('SIGINT'); } catch (e) { }
    }

    // Cancel cleanup: scan downloads directory and delete any files matching this unique downloadId suffix
    try {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      files.forEach(f => {
        if (f.includes(`_${downloadId}`)) {
          const filePath = path.join(DOWNLOADS_DIR, f);
          try { fs.unlinkSync(filePath); } catch (unlinkErr) { }
        }
      });
    } catch (err) {
      console.error('Failed to clean up files during cancellation:', err.message);
    }

    job.status = 'cancelled';
    notifyClients(downloadId);

    setTimeout(() => { 
      if (activeDownloads[downloadId]) {
        delete activeDownloads[downloadId];
      }
    }, 5000);
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Cannot cancel download' });
});

// Serve Downloaded File without auto-deleting (fixes client HTML download bug)
app.get('/api/download/file/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!filename) return res.status(400).send('Filename required');

  const filePath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found.');
  }

  // Strip the _id_downloadId or _downloadId suffix from the served filename so the user gets a clean, professional name
  let cleanFilename = filename;
  // Match format: "Title_videoID_downloadId.ext" (where downloadId is \d+_[a-z0-9]+)
  // E.g. "Title_AZjlNJF9bf0_1780005524820_ewp0s.mp4"
  const newSuffixMatch = filename.match(/(.+)(_[a-zA-Z0-9_-]+)(_\d+_[a-z0-9]+)(\.[^.]+)$/i);
  if (newSuffixMatch) {
    cleanFilename = newSuffixMatch[1] + newSuffixMatch[4];
  } else {
    // Fallback for old format: "Title_downloadId.ext"
    const oldSuffixMatch = filename.match(/(.+)(_\d+_[a-z0-9]+)(\.[^.]+)$/i);
    if (oldSuffixMatch) {
      cleanFilename = oldSuffixMatch[1] + oldSuffixMatch[3];
    }
  }

  res.download(filePath, cleanFilename, (err) => {
    if (err) {
      console.error(`Error during file download response for ${filename}:`, err.message);
    }
  });
});

// Direct Streaming Download (Sends binary stream straight to browser)
app.get('/api/download/stream', (req, res) => {
  let { url, format, title } = req.query;
  if (!url) {
    return res.status(400).send('URL query parameter is required.');
  }

  url = cleanYoutubeUrl(url);

  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'video').replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `${cleanTitle}.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

  const options = {
    output: '-',
    noWarnings: true
  };

  if (format === 'mp3') {
    options.extractAudio = true;
    options.audioFormat = 'mp3';
    options.audioQuality = '0';
    options.format = 'bestaudio/best';
  } else if (format === '720p') {
    options.format = 'best[height<=720]/best';
  } else {
    options.format = 'best'; // standard pre-merged for quick streaming without ffmpeg lag
  }

  const cp = youtubeDl.exec(url, options, {
    env: { ...process.env, YOUTUBE_DL_SKIP_PYTHON_CHECK: '1' }
  });

  cp.stdout.pipe(res);

  cp.catch(err => {
    console.error('Error streaming download:', err);
    if (!res.headersSent) {
      res.status(500).send('Error streaming download: ' + err.message);
    }
  });

  req.on('close', () => {
    try {
      cp.kill();
    } catch (e) { }
  });
});

// Library API: List downloaded files on disk
app.get('/api/library', (req, res) => {
  fs.readdir(DOWNLOADS_DIR, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to read downloads directory.' });
    }

    const items = files.map(file => {
      const filePath = path.join(DOWNLOADS_DIR, file);
      const stat = fs.statSync(filePath);
      return {
        filename: file,
        size: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
        bytes: stat.size,
        createdAt: stat.birthtime,
        isVideo: !file.endsWith('.mp3') && !file.endsWith('.m4a')
      };
    }).sort((a, b) => b.createdAt - a.createdAt);

    res.json(items);
  });
});

// Library API: Play/stream a file directly
app.get('/api/library/play/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found.');
  }

  // res.sendFile automatically handles HTTP Range requests for video/audio streaming!
  res.sendFile(filePath);
});



// Library API: Delete a file
app.delete('/api/library/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  fs.unlink(filePath, err => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete file.' });
    }
    res.json({ success: true });
  });
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` SW-YTify Downloader Server successfully booted`);
  console.log(` Running on: http://localhost:${PORT}`);
  console.log(` Downloads folder: ${DOWNLOADS_DIR}`);
  console.log(`===============================================`);
});
