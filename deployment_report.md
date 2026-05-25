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
