const express = require('express');
const path = require('path');
const fs = require('fs');
const { create } = require('youtube-dl-exec');
const ytpl = require('ytpl');
const ffmpegPath = require('ffmpeg-static');
const relativeFfmpegPath = path.relative(process.cwd(), ffmpegPath);
require('dotenv').config();

// Use system yt-dlp binary if set (Railway production), otherwise use bundled
const youtubeDl = process.env.YOUTUBE_DL_PATH
  ? create(process.env.YOUTUBE_DL_PATH)
  : require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3000;

// Set up directories
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Write YouTube cookies from environment variable to a file (for production bot bypass)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES) {
  // Railway stores multi-line env vars with literal \n — convert back to real newlines
  const cookiesContent = process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n');
  fs.writeFileSync(COOKIES_FILE, cookiesContent, 'utf8');
  console.log('[Cookies] YouTube cookies loaded from environment variable.');
  console.log('[Cookies] File size:', fs.statSync(COOKIES_FILE).size, 'bytes');
  console.log('[Cookies] First line:', cookiesContent.split('\n')[0]);
} else {
  console.log('[Cookies] No YOUTUBE_COOKIES env var found. Running without cookies.')
}
console.log('[Config] YOUTUBE_DL_PATH =', process.env.YOUTUBE_DL_PATH || '(not set - using bundled)');
console.log('[Config] Cookies file exists:', fs.existsSync(COOKIES_FILE));
console.log('[Config] NODE_ENV =', process.env.NODE_ENV || 'not set');

// Express configs
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ----------------- ROUTES -----------------

// Diagnostic debug endpoint (safe read-only info)
app.get('/api/debug', async (req, res) => {
  const { execSync } = require('child_process');
  let ytdlpVersion = 'unknown';
  let systemYtdlpVersion = 'unknown';
  try { ytdlpVersion = execSync(`"${process.env.YOUTUBE_DL_PATH || 'yt-dlp'}" --version 2>&1`).toString().trim(); } catch (e) { ytdlpVersion = e.message; }
  try { systemYtdlpVersion = execSync('yt-dlp --version 2>&1').toString().trim(); } catch (e) { systemYtdlpVersion = 'not found in PATH'; }
  res.json({
    YOUTUBE_DL_PATH: process.env.YOUTUBE_DL_PATH || '(not set)',
    cookies_file_exists: fs.existsSync(COOKIES_FILE),
    cookies_file_size: fs.existsSync(COOKIES_FILE) ? fs.statSync(COOKIES_FILE).size + ' bytes' : '0',
    YOUTUBE_COOKIES_env_set: !!process.env.YOUTUBE_COOKIES,
    bundled_ytdlp_version: ytdlpVersion,
    system_ytdlp_version: systemYtdlpVersion,
    node_version: process.version,
    platform: process.platform,
  });
});

// Home Dashboard Route
app.get('/', (req, res) => {
  res.render('index');
});

// Single Video or Playlist Metadata Extractor
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL query parameter is required.' });
  }

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
    console.log(`[Info] Using binary: ${process.env.YOUTUBE_DL_PATH || 'bundled'}`);
    const output = await youtubeDl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      skipDownload: true,
      noCheckFormats: true,
      ...(cookiesExist ? { cookies: COOKIES_FILE } : {})
    }, {
      env: { ...process.env, YOUTUBE_DL_SKIP_PYTHON_CHECK: '1' }
    });

    // Extract formatted durations and simple fields
    return res.json({
      isPlaylist: false,
      id: output.id,
      title: output.title,
      description: output.description || '',
      duration: output.duration,
      channel: output.channel || output.uploader || 'Unknown Channel',
      thumbnail: output.thumbnail || (output.thumbnails && output.thumbnails[0]?.url) || '',
      views: output.view_count || 0
    });
  } catch (err) {
    console.error('[Info] Error fetching video info:', err.message);
    return res.status(500).json({ error: 'Failed to extract video details: ' + err.message });
  }
});

// Server-Sent Events (SSE) Endpoint for Progress Updates
app.get('/api/download/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Filter in-memory downloads to only broadcast ongoing (pending/downloading) jobs on new load/refresh
  const ongoingDownloads = {};
  for (const [id, job] of Object.entries(activeDownloads)) {
    if (job.status === 'downloading' || job.status === 'pending') {
      ongoingDownloads[id] = job;
    }
  }

  // Immediately send initial state of ongoing jobs
  res.write(`data: ${JSON.stringify({ type: 'init', downloads: ongoingDownloads })}\n\n`);

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on('close', () => {
    const index = clients.findIndex(c => c.id === clientId);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });
});

// Start Server-Side Download Job
app.post('/api/download/server', (req, res) => {
  const { url, format, title } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  const downloadId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
  
  // Set up details in memory
  activeDownloads[downloadId] = {
    title: title || 'Extracting title...',
    url,
    percent: 0,
    size: '0MB',
    speed: '0KB/s',
    eta: '--:--',
    status: 'pending',
    filename: null
  };

  res.json({ success: true, downloadId });

  // Self-healing download function
  const runDownload = (isRetry = false) => {
    const options = {
      output: 'downloads/%(title)s.%(ext)s',
      noWarnings: true,
      ffmpegLocation: relativeFfmpegPath,
      ...(fs.existsSync(COOKIES_FILE) ? { cookies: COOKIES_FILE } : {})
    };

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
      options.format = 'best[height<=720]';
    } else {
      if (isRetry) {
        // Fallback: download highest pre-merged single video file (no ffmpeg merging required)
        options.format = 'best';
      } else {
        options.format = 'bestvideo+bestaudio/best';
      }
    }

    const cp = youtubeDl.exec(url, options, {
      env: { ...process.env, YOUTUBE_DL_SKIP_PYTHON_CHECK: '1' }
    });

    activeDownloads[downloadId].status = 'downloading';
    notifyClients(downloadId);

    // Parse stdout for progress updates
    cp.stdout.on('data', data => {
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
      }

      // Check for filename destinations
      const destMatch = line.match(/\[download\] Destination: (.+)/) ||
                        line.match(/\[Merging formats into "(.+)"\]/) ||
                        line.match(/\[ffmpeg\] Destination: (.+)/);
      if (destMatch) {
        const filePath = destMatch[1];
        activeDownloads[downloadId].filename = path.basename(filePath);
      }
    });

    cp.then(() => {
      activeDownloads[downloadId].percent = 100;
      activeDownloads[downloadId].status = 'completed';
      activeDownloads[downloadId].speed = '--';
      activeDownloads[downloadId].eta = '00:00';
      
      // Double check if filename wasn't captured, check download directory
      if (!activeDownloads[downloadId].filename) {
        try {
          const files = fs.readdirSync(DOWNLOADS_DIR);
          // Find most recently modified file as fallback
          const newest = files
            .map(file => ({ file, time: fs.statSync(path.join(DOWNLOADS_DIR, file)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time)[0];
          if (newest) {
            activeDownloads[downloadId].filename = newest.file;
          }
        } catch (err) {
          console.error('Fallback directory check failed:', err);
        }
      }
      notifyClients(downloadId);

      // Memory cleanup: remove completed job from cache after 10 seconds
      setTimeout(() => {
        delete activeDownloads[downloadId];
      }, 10000);
    }).catch(err => {
      // PRINT ERROR LOG ON SERVER CONSOLE WITH MAXIMUM DETAILS
      console.error(`\n[DOWNLOAD ERROR] Download Job Failed! (ID: ${downloadId}, Title: ${title || 'unknown'})`);
      if (err.stderr) {
        console.error(`stderr: ${err.stderr}`);
      }
      console.error(`message: ${err.message}\n`);

      const isFfmpegError = (err.stderr || '').includes('ffmpeg not found') || 
                            (err.stderr || '').includes('ffprobe not found') ||
                            err.message.includes('ffmpeg') ||
                            err.message.includes('ffprobe');

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

        // Memory cleanup: remove failed job from cache after 10 seconds so it doesn't linger
        setTimeout(() => {
          delete activeDownloads[downloadId];
        }, 10000);
      }
    });
  };

  runDownload();
});

// Direct Streaming Download (Sends binary stream straight to browser)
app.get('/api/download/stream', (req, res) => {
  const { url, format, title } = req.query;
  if (!url) {
    return res.status(400).send('URL query parameter is required.');
  }

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
    options.format = 'best[height<=720]';
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
    } catch (e) {}
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
        isVideo: !file.endsWith('.mp3')
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

// Dedicated route to download the completed file to the user's system
app.get('/api/download/file/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found.');
  }
  res.download(filePath, req.params.filename, (err) => {
    if (err) {
      console.error('Error during file download response:', err);
    }
  });
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
