# Cookie Management Guide (YouTube & Instagram)

To bypass bot protection, age restrictions, and 401 errors on platforms like YouTube and Instagram, `yt-dlp` needs a valid Netscape-format cookies file.

This application now uses **two separate cookie files** — one for YouTube and one for Instagram — because each platform has its own session cookies and authentication model.

## 1. How to Extract Cookies

The easiest way to extract your cookies in the correct format is by using a browser extension.

### Recommended Extension:
- **Chrome / Edge / Brave:** [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpocnjdlglpfa)
- **Firefox:** [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)

### Steps to Extract:
1. Open your browser and log into **YouTube**.
2. Click the extension icon and click **Export**. This downloads `youtube.com_cookies.txt`.
3. Open a new tab and log into **Instagram** (make sure you're fully logged in).
4. Click the extension icon again and click **Export**. This downloads `instagram.com_cookies.txt`.

## 2. Local Development

The server automatically reads these files on startup:
- `instagram.com_cookies.txt` → copied to `instagram_cookies.txt` (used for all Instagram requests)
- `cookies.txt` → used for YouTube (you need to create this from `youtube.com_cookies.txt`)

Both `instagram.com_cookies.txt` and `youtube.com_cookies.txt` **are tracked in git** for local development.
The generated `cookies.txt` and `instagram_cookies.txt` are **gitignored** (they're written at runtime).

## 3. Railway Deployment (Production)

Set these two separate environment variables in your Railway dashboard:

| Variable Name | Contents |
|---|---|
| `INSTAGRAM_COOKIES` | Full contents of your `instagram.com_cookies.txt` |
| `COOKIES_CONTENT` or `YOUTUBE_COOKIES` | Full contents of your `youtube.com_cookies.txt` (or `cookies.txt`) |

**How to paste multi-line cookies into Railway:**
Railway stores multi-line environment variables by converting real line-breaks into literal `\n`. The server automatically restores the real newlines on boot — so just paste the full file contents into the Railway variable editor.

> [!WARNING]
> Cookies expire over time (especially `sessionid` and `csrftoken` for Instagram). If downloads start failing with **401 Unauthorized** or **"Sign in required"** errors, re-export fresh cookies and update the `instagram.com_cookies.txt` file (and push to git) or update the `INSTAGRAM_COOKIES` environment variable in Railway.

> [!IMPORTANT]
> Instagram is more aggressive than YouTube about rate-limiting. The server uses a **mobile user-agent** and **`--sleep-requests`** flag to reduce the chance of 401/429 bans. If you still get 401s, try waiting a few minutes before retrying — Instagram temporarily blocks IPs that make too many rapid requests.
