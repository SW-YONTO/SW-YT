// SW-YTify Frontend Controller

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const searchForm = document.getElementById('search-form');
  const youtubeUrlInput = document.getElementById('youtube-url');
  const searchBtn = document.getElementById('search-btn');
  
  const loadingSkeleton = document.getElementById('loading-skeleton');
  const videoCard = document.getElementById('video-card');
  const playlistCard = document.getElementById('playlist-card');
  const errorCard = document.getElementById('error-card');
  const errorMessage = document.getElementById('error-message');

  // Single Video Elements
  const videoThumb = document.getElementById('video-thumb');
  const videoDuration = document.getElementById('video-duration');
  const videoTitle = document.getElementById('video-title');
  const videoChannel = document.getElementById('video-channel');
  const downloadServerBtn = document.getElementById('download-server-btn');

  // Playlist Elements
  const playlistTitle = document.getElementById('playlist-title');
  const playlistAuthor = document.getElementById('playlist-author');
  const playlistCount = document.getElementById('playlist-count');
  const playlistDownloadBtn = document.getElementById('playlist-download-btn');
  const selectAllVideos = document.getElementById('select-all-videos');
  const selectionCountEl = document.getElementById('selection-count');
  const playlistItemsList = document.getElementById('playlist-items-list');

  // Sidebar Elements
  const activeDownloadsList = document.getElementById('active-downloads-list');
  const libraryList = document.getElementById('library-list');
  const refreshLibraryBtn = document.getElementById('refresh-library-btn');

  // Modal Elements
  const playerModal = document.getElementById('player-modal');
  const playerTitle = document.getElementById('player-title');
  const closePlayerBtn = document.getElementById('close-player-btn');
  const modalVideoPlayer = document.getElementById('modal-video-player');
  const modalAudioPlayer = document.getElementById('modal-audio-player');

  // Global State Stores
  let currentMetadata = null; // Stored metadata of parsed item
  let activeDownloads = {}; // Current ongoing downloads dict
  let myClientId = null; // Unique ID assigned by server to THIS browser tab via SSE

  // Wait until the SSE connection has given us our clientId before sending downloads
  // Prevents race condition where download fires before 'connected' event arrives
  function waitForClientId(timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (myClientId) return resolve(myClientId);
      const start = Date.now();
      const poll = setInterval(() => {
        if (myClientId) {
          clearInterval(poll);
          resolve(myClientId);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          // Timed out — generate a fallback ID so the download still works
          myClientId = 'fallback_' + Date.now().toString(36);
          console.warn('[SSE] clientId not received in time, using fallback:', myClientId);
          resolve(myClientId);
        }
      }, 50);
    });
  }

  // Helper formatting for seconds to MM:SS
  function formatSeconds(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Helper clear panels
  function hideAllResultPanels() {
    loadingSkeleton.classList.add('hidden');
    videoCard.classList.add('hidden');
    playlistCard.classList.add('hidden');
    if (errorCard) errorCard.classList.add('hidden');
    const grid = document.querySelector('.content-grid');
    const col = document.querySelector('.result-column');
    if (grid) grid.classList.remove('has-result');
    if (col) col.classList.add('hidden-column');
  }

  // Format Radio Show/Hide Toggles
  document.addEventListener('change', (e) => {
    if (e.target.name === 'video-type') {
      const videoType = e.target.value;
      const videoQualWrapper = document.getElementById('video-quality-wrapper');
      const audioQualWrapper = document.getElementById('audio-quality-wrapper');
      if (videoType === 'mp4') {
        videoQualWrapper.classList.remove('hidden');
        audioQualWrapper.classList.add('hidden');
      } else {
        videoQualWrapper.classList.add('hidden');
        audioQualWrapper.classList.remove('hidden');
      }
    }
    
    if (e.target.name === 'playlist-type') {
      const playlistType = e.target.value;
      const playlistVideoQualWrapper = document.getElementById('playlist-video-quality-wrapper');
      const playlistAudioQualWrapper = document.getElementById('playlist-audio-quality-wrapper');
      if (playlistType === 'mp4') {
        playlistVideoQualWrapper.classList.remove('hidden');
        playlistAudioQualWrapper.classList.add('hidden');
      } else {
        playlistVideoQualWrapper.classList.add('hidden');
        playlistAudioQualWrapper.classList.remove('hidden');
      }
    }
  });

  // ----------------- SEARCH & EXTRACT -----------------

  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = youtubeUrlInput.value.trim();
    if (!url) return;

    hideAllResultPanels();
    const grid = document.querySelector('.content-grid');
    const col = document.querySelector('.result-column');
    if (grid) grid.classList.add('has-result');
    if (col) col.classList.remove('hidden-column');
    loadingSkeleton.classList.remove('hidden');
    searchBtn.disabled = true;

    try {
      const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to extract URL details');
      }

      currentMetadata = await response.json();
      renderExtractorResult(currentMetadata);
    } catch (err) {
      console.error('Extraction Error:', err.message);
      hideAllResultPanels();
      
      // Dynamic invalid link/extraction error indicator UI
      if (grid) grid.classList.add('has-result');
      if (col) col.classList.remove('hidden-column');
      if (errorCard && errorMessage) {
        errorMessage.textContent = err.message || 'Failed to extract URL details';
        errorCard.classList.remove('hidden');
      }
    } finally {
      searchBtn.disabled = false;
    }
  });

  function renderExtractorResult(data) {
    hideAllResultPanels();
    const grid = document.querySelector('.content-grid');
    const col = document.querySelector('.result-column');
    if (grid) grid.classList.add('has-result');
    if (col) col.classList.remove('hidden-column');

    if (data.isPlaylist) {
      // Setup Playlist Details
      playlistTitle.textContent = data.title;
      playlistAuthor.textContent = data.author;
      playlistCount.textContent = data.videoCount;

      const formatContainer = document.getElementById('playlist-format-options-container');
      if (data.isImageCarousel) {
        formatContainer.classList.add('hidden');
        document.getElementById('select-all-videos').nextSibling.textContent = ' Select All Images';
      } else {
        formatContainer.classList.remove('hidden');
        document.getElementById('select-all-videos').nextSibling.textContent = ' Select All Videos';
      }
      
      // Clear and render items list
      playlistItemsList.innerHTML = '';
      data.items.forEach((item, index) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'playlist-item';
        itemEl.innerHTML = `
          <label class="custom-checkbox playlist-item-checkbox">
            <input type="checkbox" class="video-checkbox" data-index="${index}" checked>
            <span class="checkmark"></span>
          </label>
          <img src="/api/proxy-image?url=${encodeURIComponent(item.thumbnail)}" class="playlist-item-thumb" alt="Thumb" onerror="this.src='https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=150&auto=format&fit=crop'">
          <div class="playlist-item-meta">
            <h4>${item.title}</h4>
            <p>${item.duration || '0:00'}</p>
          </div>
        `;
        playlistItemsList.appendChild(itemEl);
      });

      playlistCard.classList.remove('hidden');
      updatePlaylistSelectionCount();
      setupPlaylistListeners();
    } else {
      // Setup Single Video Details
      videoTitle.textContent = data.title;
      videoChannel.innerHTML = `<i data-lucide="user"></i> ${data.channel}`;
      videoDuration.textContent = formatSeconds(data.duration);
      videoThumb.src = data.thumbnail ? `/api/proxy-image?url=${encodeURIComponent(data.thumbnail)}` : 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&auto=format&fit=crop';
      
      videoCard.classList.remove('hidden');
      lucide.createIcons(); // render channel icon
    }
  }

  // Playlist selection updates
  function updatePlaylistSelectionCount() {
    const total = playlistItemsList.querySelectorAll('.video-checkbox').length;
    const selected = playlistItemsList.querySelectorAll('.video-checkbox:checked').length;
    selectionCountEl.textContent = `${selected} of ${total} selected`;
    selectAllVideos.checked = (total === selected);
  }

  function setupPlaylistListeners() {
    const checkboxes = playlistItemsList.querySelectorAll('.video-checkbox');
    checkboxes.forEach(cb => {
      cb.addEventListener('change', updatePlaylistSelectionCount);
    });
  }

  selectAllVideos.addEventListener('change', () => {
    const isChecked = selectAllVideos.checked;
    const checkboxes = playlistItemsList.querySelectorAll('.video-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = isChecked;
    });
    updatePlaylistSelectionCount();
  });

  // ----------------- DOWNLOAD HANDLERS -----------------

  // Single: Save to Server Download
  downloadServerBtn.addEventListener('click', async () => {
    if (!currentMetadata || currentMetadata.isPlaylist) return;
    
    const type = document.querySelector('input[name="video-type"]:checked').value;
    let format = 'best';
    if (type === 'mp3') {
      format = 'mp3';
    } else {
      format = document.getElementById('video-quality').value;
    }
    
    const url = youtubeUrlInput.value.trim();
    
    try {
      const clientId = await waitForClientId();
      const res = await fetch('/api/download/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          format,
          title: currentMetadata.title,
          id: currentMetadata.id,
          ownerClientId: clientId   // tag this job so only THIS tab triggers the browser download
        })
      });
      const data = await res.json();
      if (!data.success) {
        console.error('Server failed to initiate download: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('Network error requesting download:', err.message);
    }
  });

  // Playlist: Bulk Server Download
  playlistDownloadBtn.addEventListener('click', async () => {
    if (!currentMetadata || !currentMetadata.isPlaylist) return;

    const checkedBoxes = playlistItemsList.querySelectorAll('.video-checkbox:checked');
    if (checkedBoxes.length === 0) {
      console.error('Please select at least one video to download.');
      return;
    }

    let format = 'best';
    if (currentMetadata.isImageCarousel) {
      format = 'image';
    } else {
      const type = document.querySelector('input[name="playlist-type"]:checked').value;
      if (type === 'mp3') {
        format = 'mp3';
      } else {
        format = document.getElementById('playlist-video-quality').value;
      }
    }
    
    // Start downloads with staggered delay to avoid YouTube rate-limiting
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const clientId = await waitForClientId(); // ensure we have our ID before looping
    for (let i = 0; i < checkedBoxes.length; i++) {
      const cb = checkedBoxes[i];
      const idx = parseInt(cb.getAttribute('data-index'));
      const item = currentMetadata.items[idx];
      
      try {
        await fetch('/api/download/server', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.url,
            format,
            title: item.title,
            id: item.id,
            ownerClientId: clientId   // tag this job so only THIS tab triggers the browser download
          })
        });
        // Wait 2 seconds between jobs to prevent rate-limiting (skip delay after last item)
        if (i < checkedBoxes.length - 1) {
          await delay(2000);
        }
      } catch (err) {
        console.error('Failed to trigger playlist item download:', item.title, err);
      }
    }
  });

  // ----------------- SERVER PROGRESS LISTENER (SSE) -----------------

  const eventSource = new EventSource('/api/download/progress');
  const triggeredDownloads = new Set();

  function triggerBrowserDownload(filename) {
    const downloadUrl = `/api/download/file/${encodeURIComponent(filename)}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'connected') {
        // Server assigned us a unique ID for this browser tab session
        myClientId = data.clientId;
        console.log('[SSE] Connected. My client ID:', myClientId);

      } else if (data.type === 'init') {
        // Keep completed/error downloads that are currently in activeDownloads to prevent auto-clearing
        const preservedDownloads = {};
        for (const [id, job] of Object.entries(activeDownloads)) {
          if (job.status === 'completed' || job.status === 'error') {
            preservedDownloads[id] = job;
          }
        }
        activeDownloads = { ...preservedDownloads, ...data.downloads };
        renderAllDownloads();

      } else if (data.type === 'update') {
        activeDownloads[data.downloadId] = data.job;
        updateDownloadCard(data.downloadId, data.job);

        // Only trigger browser download on the tab that OWNS this job.
        // CASE 1: ownerClientId is set (new code) → strict match, only owner device downloads
        // CASE 2: ownerClientId is null (old cached JS sent null) → first client to see it downloads
        if (data.job.status === 'completed' && data.job.filename) {
          const jobOwner = data.job.ownerClientId;
          const isOwner = jobOwner
            ? jobOwner === myClientId          // new code: must be the owner
            : !triggeredDownloads.has(data.downloadId); // old code fallback: first-come-first-served

          console.log(`[Download] Job ${data.downloadId} completed.`,
            `jobOwner=${jobOwner}, myClientId=${myClientId}, isOwner=${isOwner}`);

          if (isOwner && !triggeredDownloads.has(data.downloadId)) {
            triggeredDownloads.add(data.downloadId);
            triggerBrowserDownload(data.job.filename);
          }
        }
      }
    } catch (err) {
      console.error('Error handling SSE message:', err);
    }
  };

  eventSource.onerror = (e) => {
    console.error('SSE connection lost. Reconnecting...', e);
  };

  function renderAllDownloads() {
    activeDownloadsList.innerHTML = '';
    const keys = Object.keys(activeDownloads);
    
    if (keys.length === 0) {
      activeDownloadsList.innerHTML = '<div class="no-downloads-msg">No active downloads running</div>';
      return;
    }

    // Sort downloads by timestamp key to show newest at bottom/top
    keys.sort().forEach(id => {
      createOrUpdateDownloadCard(id, activeDownloads[id]);
    });
  }

  function createOrUpdateDownloadCard(id, job) {
    let card = document.getElementById(`job-${id}`);
    if (!card) {
      card = document.createElement('div');
      card.id = `job-${id}`;
      activeDownloadsList.appendChild(card);
    }
    
    card.className = `download-job-card ${job.status}`;
    card.innerHTML = `
      <div class="job-header">
        <span class="job-title" title="${job.title}">${job.title}</span>
        <div class="job-header-right">
          <span class="job-badge status-${job.status}">${job.status}</span>
          ${(job.status === 'downloading' || job.status === 'pending') ? `
            <button class="cancel-btn" onclick="cancelDownload('${id}')" title="Cancel">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
            </button>
          ` : ''}
        </div>
      </div>
      <div class="progress-bar-container">
        <div class="progress-bar-fill" style="width: ${job.percent}%"></div>
      </div>
      <div class="job-meta-row">
        <div class="job-meta-left">
          <span>${job.percent}%</span>
          <span class="job-size">${job.size || ''}</span>
        </div>
        <div>
          <span class="job-speed">${job.speed || ''}</span>
          <span style="margin: 0 4px">|</span>
          <span class="job-eta">ETA ${job.eta || ''}</span>
        </div>
      </div>
      ${job.status === 'error' ? `<div class="job-error-msg">Error: ${job.error || 'Failed'}</div>` : ''}
    `;
  }

  function updateDownloadCard(id, job) {
    // Remove "No active downloads" message if present
    const noMsg = activeDownloadsList.querySelector('.no-downloads-msg');
    if (noMsg) noMsg.remove();

    let card = document.getElementById(`job-${id}`);
    if (!card) {
      createOrUpdateDownloadCard(id, job);
      return;
    }

    card.className = `download-job-card ${job.status}`;
    const fill = card.querySelector('.progress-bar-fill');
    const badge = card.querySelector('.job-badge');
    const percentSpan = card.querySelector('.job-meta-left span');
    const sizeSpan = card.querySelector('.job-size');
    const speedSpan = card.querySelector('.job-speed');
    const etaSpan = card.querySelector('.job-eta');

    if (fill) fill.style.width = `${job.percent}%`;
    if (badge) {
      badge.textContent = job.status;
      badge.className = `job-badge status-${job.status}`;
    }
    if (percentSpan) percentSpan.textContent = `${job.percent}%`;
    if (sizeSpan) sizeSpan.textContent = job.size || '';
    if (speedSpan) speedSpan.textContent = job.speed || '';
    if (etaSpan) etaSpan.textContent = `ETA ${job.eta || ''}`;

    // Remove cancel button when transition to completed, cancelled, or error
    const cancelBtn = card.querySelector('.cancel-btn');
    if (cancelBtn && (job.status === 'completed' || job.status === 'cancelled' || job.status === 'error')) {
      cancelBtn.remove();
    }

    // Append error details if not already present
    if (job.status === 'error') {
      let errorMsgDiv = card.querySelector('.job-error-msg');
      if (!errorMsgDiv) {
        errorMsgDiv = document.createElement('div');
        errorMsgDiv.className = 'job-error-msg';
        card.appendChild(errorMsgDiv);
      }
      errorMsgDiv.textContent = `Error: ${job.error || 'Failed'}`;
    }

    // If card transition to completed or cancelled, clear details after a delay
    if (job.status === 'completed' || job.status === 'cancelled') {
      setTimeout(() => {
        // Gently fade out completed/cancelled jobs after 5 seconds to keep the list clean
        card.style.opacity = '0';
        card.style.transition = 'all 1s';
        setTimeout(() => {
          card.remove();
          delete activeDownloads[id];
          if (Object.keys(activeDownloads).length === 0) {
            activeDownloadsList.innerHTML = '<div class="no-downloads-msg">No active downloads running</div>';
          }
        }, 1000);
      }, 5000);
    }
  }


  // ----------------- PWA INSTALLATION HANDLER -----------------
  let deferredPrompt = null;
  const pwaInstallBtn = document.getElementById('pwa-install-btn');

  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // Update UI to show the premium install button
    if (pwaInstallBtn) {
      pwaInstallBtn.classList.remove('hidden');
      // Re-initialize icons just in case Lucide needs to render the smartphone icon inside it
      if (window.lucide) {
        window.lucide.createIcons();
      }
    }
    console.log('[PWA] beforeinstallprompt event fired and captured');
  });

  if (pwaInstallBtn) {
    pwaInstallBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      // Show the install prompt
      deferredPrompt.prompt();
      // Wait for the user to respond to the prompt
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`[PWA] User response to the install prompt: ${outcome}`);
      // We've used the prompt, and can't use it again
      deferredPrompt = null;
      // Hide the install button
      pwaInstallBtn.classList.add('hidden');
    });
  }

  window.addEventListener('appinstalled', (event) => {
    // Clear the deferredPrompt
    deferredPrompt = null;
    // Hide the install button
    if (pwaInstallBtn) {
      pwaInstallBtn.classList.add('hidden');
    }
    console.log('[PWA] Application was successfully installed!');
  });

  // Expose global cancel function for the inline onclick handler
  window.cancelDownload = async (id) => {
    try {
      const btn = document.querySelector(`#job-${id} .cancel-btn`);
      if (btn) btn.disabled = true;
      
      const res = await fetch('/api/download/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId: id })
      });
      const data = await res.json();
      if (!data.success) {
        console.error('Failed to cancel download:', data.error);
        if (btn) btn.disabled = false;
      }
    } catch (err) {
      console.error('Network error cancelling download:', err);
    }
  };

});
