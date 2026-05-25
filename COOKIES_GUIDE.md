# Cookie Management Guide (YouTube & Instagram)

To bypass bot protection and age restrictions on platforms like YouTube and Instagram, `yt-dlp` needs a valid Netscape-format `cookies.txt` file.

This application is configured to look for a single `cookies.txt` file in the root directory (or read from the `COOKIES_CONTENT` environment variable). This single file can hold cookies for *multiple* websites (e.g., both youtube.com and instagram.com).

## 1. How to Extract Cookies

The easiest way to extract your cookies in the correct format is by using a browser extension.

### Recommended Extension:
- **Chrome / Edge / Brave:** [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpocnjdlglpfa)
- **Firefox:** [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)

### Steps to Extract:
1. Open your browser and log into **YouTube**.
2. Click the extension icon and click **Export**. This will download a file (e.g., `youtube.com_cookies.txt`).
3. Open a new tab and log into **Instagram**.
4. Click the extension icon again and click **Export**. This will download a second file (e.g., `instagram.com_cookies.txt`).

## 2. Combine and Deploy

1. Create a new file named `cookies.txt` in the root folder of this project.
2. Open the downloaded YouTube cookies file in a text editor, copy all of its contents, and paste them into `cookies.txt`.
3. Open the downloaded Instagram cookies file, copy all of its contents, and append them directly below the YouTube cookies in `cookies.txt`.
4. Your `cookies.txt` file should now contain hundreds of lines from both domains.

### Railway Deployment

You have two options for providing these cookies to your Railway server:

**Option A: GitHub Commit (Recommended for Speed)**
Simply commit the `cookies.txt` file to your GitHub repository and push it. The server will automatically detect and use `cookies.txt` during the build and runtime. Railway will pick up the changes instantly.

**Option B: Environment Variable**
If you prefer not to commit cookies to GitHub (for security reasons), you can copy the entire contents of your combined `cookies.txt` file and paste it into a new Environment Variable in your Railway dashboard named `COOKIES_CONTENT`. The server will automatically generate a local `cookies.txt` using this data when it boots up.

> [!WARNING]
> Cookies expire over time (especially session cookies for platforms like Instagram). If you notice downloads failing in the future with "Sign in required" or "Cookie Error" messages, you will need to re-extract the cookies using the steps above and update your file or environment variable.
