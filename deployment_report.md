# SW-YTify Deployment & Debugging Report

This document explains the technical challenges we faced when moving the YouTube Downloader from your local Windows machine to a production server on Railway, and how we solved them.

## The Core Problem: Local vs. Datacenter IPs
YouTube handles traffic very differently depending on where it comes from:
- **Localhost (Your PC):** YouTube trusts residential home network IPs. `yt-dlp` runs smoothly here without being challenged.
- **Production (Railway):** Railway is a cloud hosting provider. YouTube heavily monitors and restricts traffic from known datacenter IPs to prevent server farms from mass-downloading videos. 

This environment difference triggered a cascade of three major issues when we deployed to production.

---

### Issue 1: The Bot Detection Block ("Sign in to confirm you’re not a bot")
**The Problem:**
Because the request came from a datacenter, YouTube immediately hit us with a CAPTCHA wall. `yt-dlp` cannot solve visual CAPTCHAs, so it completely failed to load the webpage.

**The Solution:**
We authenticated the requests using your personal YouTube **Cookies**.
1. We exported your YouTube session into a `cookies.txt` file.
2. We stored this data in Railway as the `YOUTUBE_COOKIES` environment variable.
3. *The tricky part:* Railway stores multi-line environment variables by converting real line-breaks into literal `\n` text characters. This broke the formatting of the `cookies.txt` file. We added a quick `.replace(/\\n/g, '\n')` in `server.js` to restore the real line-breaks before feeding it to `yt-dlp`.

---

### Issue 2: "Requested format is not available" (The Outdated Binary Problem)
**The Problem:**
YouTube changes its API and video format structures almost every week. The npm package we are using (`youtube-dl-exec`) comes bundled with a "frozen" version of `yt-dlp`. While it worked locally, it was slightly out of date and couldn't resolve the latest format structures that YouTube was forcing on the production datacenter.

**The Solution:**
We bypassed the outdated bundled version.
1. We updated the **Dockerfile** to manually download the absolute latest `yt-dlp` binary directly from GitHub during deployment.
2. We updated `server.js` to look for an environment variable called `YOUTUBE_DL_PATH`. If it exists (like on Railway), the app uses the fresh system-level `yt-dlp` instead of the old npm one.

---

### Issue 3: The JavaScript Challenge (The Final Confusing Fix)
**The Problem:**
Even with cookies and the newest binary, we still got `Requested format is not available`. 
Through our custom `/api/test-ytdlp` diagnostic endpoint, we discovered the real underlying error: **HTTP 429 Too Many Requests**.

YouTube was *still* heavily rate-limiting the Railway IP. When YouTube rate-limits a connection, it serves a complex **JavaScript challenge** (a mathematical cipher) that a real web browser would execute in the background to prove it's legitimate. 

`yt-dlp` *is* capable of solving this JS challenge! However, it needs a JavaScript runtime engine (like Node.js, Python, or Deno) to do the math. 
By default, `yt-dlp` looks for `deno` or `phantomjs`. Because Railway's slim Docker container only had Node.js installed, `yt-dlp` couldn't find its preferred runtime, silently failed the challenge, and returned an empty list of video formats (leaving only image thumbnails).

**The Solution:**
We added the **`jsRuntimes: 'node'`** flag to our configuration.
This forces `yt-dlp` to execute the `--js-runtimes node` command-line argument. This simple instruction told `yt-dlp`: *"Hey, use the Node.js engine that's already running this server to solve YouTube's mathematical cipher."*

Once `yt-dlp` used Node to solve the JS challenge, YouTube verified the request, unlocked the 429 block, and allowed us to extract the full `mp4` and `mp3` formats!

---

### Issue 4: Instagram 401 Unauthorized (The Separate Cookie Problem)
**The Problem:**
Instagram downloads were failing with a `401 Unauthorized` error even though cookies were present. The root cause was **two compounding bugs**:

1. **Wrong cookies being sent:** The server was passing the YouTube `cookies.txt` to `yt-dlp` for Instagram requests. Instagram requires its **own session cookies** (`sessionid`, `csrftoken`, `ds_user_id`, `rur`) — YouTube cookies are completely useless for Instagram.

2. **The cookie file was gitignored:** The `.gitignore` had a wildcard `*_cookies.txt` rule which blocked `instagram.com_cookies.txt` from ever reaching Railway via GitHub. So the production server had no Instagram cookies at all.

3. **Wrong user-agent:** Instagram's API is very strict. Requests without a proper mobile browser user-agent (or with a bot-like `python-requests` UA) are immediately rejected with 401.

4. **Rate limiting (401/429 from rapid requests):** Instagram temporarily blocks IPs that send too many requests in quick succession, returning 401/403 even with valid cookies.

**The Solution:**
We implemented a complete Instagram authentication pipeline:

1. **Separate cookie file and env var:** Added a new `INSTAGRAM_COOKIES` environment variable on Railway. `server.js` now writes this to `instagram_cookies.txt` separately from the YouTube `cookies.txt`.

2. **Fixed gitignore:** Changed `*_cookies.txt` (wildcard) to only ignore the auto-generated files (`cookies.txt` and `instagram_cookies.txt`). The source files `instagram.com_cookies.txt` and `youtube.com_cookies.txt` are now tracked in git for local development reference.

3. **Mobile user-agent injection:** Added `--add-header` flags to pass a valid iPhone user-agent and `Accept-Language` header to every Instagram request. This makes the server look like a real mobile browser to Instagram.

4. **Request throttling:** Added `--sleep-requests 1` (info) and `--sleep-requests 2` (download) flags. This adds a small delay between requests to Instagram, reducing the chance of rate-limit 401/429 errors.

5. **Correct format for Instagram:** Instagram serves pre-merged single video streams — you can't request `bestvideo+bestaudio` (that's a YouTube-specific feature). The format is always set to `best` for Instagram URLs.

