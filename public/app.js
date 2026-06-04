// State Management
let sessionId = null;
let stream = null;
let mediaRecorder = null;
let chunkIndex = 0;
let isActive = false;
let currentTab = 'chunks'; // 'chunks' or 'events'
let chunkInterval = null; // Timer to capture and restart recording chunks

// DOM Elements
const startTestBtn = document.getElementById('startTestBtn');
const stopTestBtn = document.getElementById('stopTestBtn');
const screenShareIndicator = document.getElementById('screenShareIndicator');
const recordingIndicator = document.getElementById('recordingIndicator');
const sessionIdVal = document.getElementById('sessionIdVal');
const previewVideo = document.getElementById('previewVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const logConsole = document.getElementById('logConsole');
const clearLogsBtn = document.getElementById('clearLogsBtn');

const refreshChunksBtn = document.getElementById('refreshChunksBtn');
const refreshEventsBtn = document.getElementById('refreshEventsBtn');
const tabChunksBtn = document.getElementById('tabChunksBtn');
const tabEventsBtn = document.getElementById('tabEventsBtn');
const inspectorContent = document.getElementById('inspectorContent');

// Helper: Generate UUID/Unique ID for Session
function generateSessionId() {
  const prefix = 'sess';
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${randomStr}`;
}

// Helper: Format event class type based on string type for colored logs in UI console
function getLogClass(type) {
  if (type.startsWith('screen_share') || type.startsWith('recording')) {
    return 'event-flow';
  }
  if (['window_blur', 'visibility_hidden'].includes(type)) {
    return 'event-warn';
  }
  if (['window_focus', 'visibility_visible'].includes(type)) {
    return 'system-msg';
  }
  if (['copy', 'paste', 'keydown', 'resize'].includes(type)) {
    return 'event-interact';
  }
  return 'system-msg';
}

// Log Event to UI console and send to Backend
async function logEvent(type, metadata = {}) {
  const timestamp = new Date().toISOString();
  const timeStr = new Date().toLocaleTimeString();

  // 1. Log to UI console
  const entry = document.createElement('div');
  entry.className = `log-entry ${getLogClass(type)}`;
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = `[${timeStr}]`;
  
  entry.appendChild(timeSpan);
  
  let msg = `${type.toUpperCase()}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` - ${JSON.stringify(metadata)}`;
  }
  
  entry.appendChild(document.createTextNode(msg));
  logConsole.appendChild(entry);
  logConsole.scrollTop = logConsole.scrollHeight;

  // 2. Upload event to Backend if session is initialized
  if (sessionId) {
    try {
      const response = await fetch('/api/proctoring/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          type,
          timestamp,
          metadata
        })
      });
      if (!response.ok) {
        console.error('Failed to send event to backend', await response.text());
      }
    } catch (err) {
      console.error('Network error sending event to backend:', err);
    }
  }
}

// Clear UI Console Logs
clearLogsBtn.addEventListener('click', () => {
  logConsole.innerHTML = '<div class="log-entry system-msg">[SYSTEM] Log cleared. Session is still active.</div>';
});

// Start Test Handler
startTestBtn.addEventListener('click', async () => {
  try {
    startTestBtn.disabled = true;
    
    // 1. Generate unique session ID
    sessionId = generateSessionId();
    sessionIdVal.textContent = sessionId;
    chunkIndex = 0;
    isActive = true;

    await logEvent('session_initialized', { sessionId });

    // Enable Inspector Controls
    refreshChunksBtn.disabled = false;
    refreshEventsBtn.disabled = false;

    // 2. Request Display Stream
    // Browser Context: The app cannot silently initiate screen sharing. This must be triggered by direct user action.
    // We request both video and audio. Note: Some browsers/OS environments might reject system audio stream selection.
    await logEvent('requesting_screen_share');
    
    // Preferences: Request sharing the entire screen/monitor by default
    const displayMediaOptions = {
      video: {
        displaySurface: "monitor"
      },
      audio: true
    };

    try {
      stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
    } catch (streamErr) {
      console.warn("DisplayMedia with audio failed or declined, falling back to video-only stream...", streamErr);
      // Fallback request without audio track, but keeping the monitor preference
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "monitor"
        }
      });
    }

    // Verify if the user shared their entire screen/monitor
    const videoTrack = stream.getVideoTracks()[0];
    const settings = videoTrack ? videoTrack.getSettings() : {};
    
    await logEvent('screen_share_surface_detected', { displaySurface: settings.displaySurface || 'unknown' });

    // Strict validation: Reject if the surface is not explicitly 'monitor' (entire screen)
    if (settings.displaySurface !== 'monitor') {
      // Immediately stop the stream tracks to release browser sharing overlays
      stream.getTracks().forEach(track => track.stop());
      throw new Error(`Access Denied: You must share your ENTIRE screen/monitor. Selecting a single window or browser tab is not allowed. (Detected surface: ${settings.displaySurface || 'unknown'})`);
    }

    await logEvent('screen_share_started', {
      hasAudio: stream.getAudioTracks().length > 0,
      videoTrackLabel: stream.getVideoTracks()[0]?.label
    });

    // 3. Show stream in UI Video Element
    previewVideo.srcObject = stream;
    previewVideo.style.display = 'block';
    videoPlaceholder.style.display = 'none';
    
    // Update UI Indicators
    screenShareIndicator.className = 'status-badge status-active';
    screenShareIndicator.textContent = 'Screen Share Active';

    // 4. Detect user stopping screen share via Chrome native overlay controls
    if (videoTrack) {
      videoTrack.onended = () => {
        logEvent('screen_share_stopped', { reason: 'User clicked browser native overlay Stop button' });
        stopTest();
      };
    }

    // 5. Initialize MediaRecorder helper
    let mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      const fallbacks = ['video/webm;codecs=vp8', 'video/webm;codecs=daala', 'video/webm;codecs=h264', 'video/mp4'];
      for (const type of fallbacks) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          break;
        }
      }
    }

    await logEvent('recording_started', { mimeType });

    // Function to start a single independent recording slice
    const recordNextChunk = () => {
      if (!isActive) return;

      // Verify track status before starting recorder
      const track = stream ? stream.getVideoTracks()[0] : null;
      if (!track || track.readyState === 'ended') {
        logEvent('screen_share_stopped', { reason: 'Detected ended track state before starting chunk' });
        stopTest();
        return;
      }

      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          chunkIndex++;
          const currentChunk = chunkIndex;
          await logEvent('chunk_captured', { chunkIndex: currentChunk, sizeBytes: e.data.size });
          await uploadChunk(e.data, currentChunk);
        }
      };

      mediaRecorder.start();
    };

    // Start recording the first chunk immediately
    recordNextChunk();

    // Periodically stop the current recorder to flush out a valid standalone WebM file,
    // and immediately start the next recorder to capture the next slice.
    chunkInterval = setInterval(() => {
      // Fail-safe: Detect if the user stopped screen sharing from the browser UI
      const track = stream ? stream.getVideoTracks()[0] : null;
      if (!track || track.readyState === 'ended') {
        logEvent('screen_share_stopped', { reason: 'Detected ended track state via interval timer' });
        stopTest();
        return;
      }

      if (isActive && mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        recordNextChunk();
      }
    }, 5000);
    
    // Update UI Indicators
    recordingIndicator.className = 'status-badge status-recording';
    recordingIndicator.textContent = 'Recording (5s Chunks)';
    
    // Enable Stop Button
    stopTestBtn.disabled = false;

  } catch (err) {
    await logEvent('error', { message: err.message, name: err.name });
    alert(`Failed to start test proctoring: ${err.message || err}`);
    resetUI();
  }
});

// Stop Test Handler
stopTestBtn.addEventListener('click', async () => {
  await logEvent('test_ended_by_user');
  stopTest();
});

// Stop Proctoring Flow
function stopTest() {
  if (!isActive) return;
  isActive = false;

  logEvent('recording_stopped');

  // Clear chunking timer
  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  // Stop Media Recorder
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  // Stop all media tracks to release screen recording permission
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  // Reset Video Screen Element
  previewVideo.srcObject = null;
  previewVideo.style.display = 'none';
  videoPlaceholder.style.display = 'flex';

  // Update Status UI
  recordingIndicator.className = 'status-badge status-inactive';
  recordingIndicator.textContent = 'Recording Off';
  screenShareIndicator.className = 'status-badge status-inactive';
  screenShareIndicator.textContent = 'Screen Share Off';

  startTestBtn.disabled = false;
  stopTestBtn.disabled = true;

  logEvent('session_completed');
}

// Reset UI helper on error
function resetUI() {
  isActive = false;

  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  startTestBtn.disabled = false;
  stopTestBtn.disabled = true;
  
  recordingIndicator.className = 'status-badge status-inactive';
  recordingIndicator.textContent = 'Recording Off';
  screenShareIndicator.className = 'status-badge status-inactive';
  screenShareIndicator.textContent = 'Screen Share Off';

  previewVideo.srcObject = null;
  previewVideo.style.display = 'none';
  videoPlaceholder.style.display = 'flex';
}

// Upload file chunk to Backend
async function uploadChunk(blob, index) {
  try {
    // IMPORTANT: Form data layout matters. Append text/string fields BEFORE the file blob
    // so multer's diskStorage destination callback can properly parse req.body.sessionId.
    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('chunkIndex', String(index));
    formData.append('recording', blob, `chunk-${index}.webm`);

    const response = await fetch('/api/recording/chunk', {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      const data = await response.json();
      await logEvent('chunk_uploaded', { chunkIndex: index, serverPath: data.path });
      
      // Auto refresh inspection panel to show chunk list
      if (currentTab === 'chunks') {
        fetchChunks();
      }
    } else {
      const errMsg = await response.text();
      await logEvent('chunk_upload_failed', { chunkIndex: index, error: errMsg });
    }
  } catch (err) {
    await logEvent('chunk_upload_network_error', { chunkIndex: index, error: err.message });
  }
}

// Event Listeners for Proctoring Details

// 1. Focus & Blur
window.addEventListener('focus', () => {
  if (isActive) logEvent('window_focus');
});
window.addEventListener('blur', () => {
  if (isActive) logEvent('window_blur');
});

// 2. Tab/Page Visibility Change
document.addEventListener('visibilitychange', () => {
  if (isActive) {
    const visibilityState = document.visibilityState;
    logEvent(`visibility_${visibilityState}`, { state: visibilityState });
  }
});

// 3. Window Resize
window.addEventListener('resize', () => {
  if (isActive) {
    logEvent('resize', {
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    });
  }
});

// 4. Clipboard Interceptions (Copy/Paste)
document.addEventListener('copy', (e) => {
  if (isActive) {
    const selectedText = window.getSelection() ? window.getSelection().toString() : '';
    logEvent('copy', {
      charCount: selectedText.length,
      snippet: selectedText.substring(0, 30)
    });
  }
});

document.addEventListener('paste', (e) => {
  if (isActive) {
    let pastedText = '';
    try {
      pastedText = e.clipboardData ? e.clipboardData.getData('text') : '';
    } catch (clipboardErr) {
      pastedText = '[Unreadable Clipboard]';
    }
    
    logEvent('paste', {
      charCount: pastedText.length,
      snippet: pastedText.substring(0, 30)
    });
  }
});

// 5. Keyboard activity monitoring
document.addEventListener('keydown', (e) => {
  if (isActive) {
    // Record action/special keys or layout switches to identify activity patterns
    logEvent('keydown', {
      key: e.key,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey
    });
  }
});


// Backend Upload Inspector Panel Logic

async function fetchChunks() {
  if (!sessionId) return;
  try {
    const response = await fetch(`/api/session/${sessionId}/chunks`);
    if (response.ok) {
      const data = await response.json();
      inspectorContent.textContent = JSON.stringify(data, null, 2);
    } else {
      inspectorContent.textContent = `Server responded: ${response.status} ${response.statusText}\n${await response.text()}`;
    }
  } catch (err) {
    inspectorContent.textContent = `Error fetching chunks list: ${err.message}`;
  }
}

async function fetchEvents() {
  if (!sessionId) return;
  try {
    const response = await fetch(`/api/session/${sessionId}/events`);
    if (response.ok) {
      const data = await response.json();
      inspectorContent.textContent = data.events.map(ev => JSON.stringify(ev)).join('\n');
    } else {
      inspectorContent.textContent = `Server responded: ${response.status} ${response.statusText}\n${await response.text()}`;
    }
  } catch (err) {
    inspectorContent.textContent = `Error fetching events: ${err.message}`;
  }
}

// Tab Switches
tabChunksBtn.addEventListener('click', () => {
  currentTab = 'chunks';
  tabChunksBtn.classList.add('active');
  tabEventsBtn.classList.remove('active');
  fetchChunks();
});

tabEventsBtn.addEventListener('click', () => {
  currentTab = 'events';
  tabEventsBtn.classList.add('active');
  tabChunksBtn.classList.remove('active');
  fetchEvents();
});

refreshChunksBtn.addEventListener('click', fetchChunks);
refreshEventsBtn.addEventListener('click', fetchEvents);


/* ==========================================================================
   Recordings Review Feature Controllers and Router
   ========================================================================== */

const sandboxView = document.getElementById('sandboxView');
const recordingsListView = document.getElementById('recordingsListView');
const reviewSessionView = document.getElementById('reviewSessionView');
const navSandbox = document.getElementById('navSandbox');
const navRecordings = document.getElementById('navRecordings');

// Router logic
function router() {
  const path = window.location.pathname;

  // Clear navigation highlights
  navSandbox.classList.remove('active');
  navRecordings.classList.remove('active');

  // Hide all views
  sandboxView.classList.remove('active');
  recordingsListView.classList.remove('active');
  reviewSessionView.classList.remove('active');

  if (path === '/' || path === '/sandbox') {
    navSandbox.classList.add('active');
    sandboxView.classList.add('active');
  } else if (path === '/recordings') {
    navRecordings.classList.add('active');
    recordingsListView.classList.add('active');
    loadRecordingsList();
  } else if (path.startsWith('/recordings/')) {
    navRecordings.classList.add('active');
    reviewSessionView.classList.add('active');
    const id = path.split('/')[2];
    loadReviewSession(id);
  } else {
    navSandbox.classList.add('active');
    sandboxView.classList.add('active');
    window.history.replaceState(null, '', '/sandbox');
  }
}

// Intercept clicks on custom data-link anchors
document.addEventListener('click', (e) => {
  const targetLink = e.target.closest('a[data-link]');
  if (targetLink) {
    e.preventDefault();
    const href = targetLink.getAttribute('href');

    // Confirm session termination if switching views during a test
    if (isActive && href !== '/sandbox') {
      const confirmLeave = confirm("Are you sure? Navigating away will stop your current proctoring test.");
      if (!confirmLeave) return;
      logEvent('test_ended_by_navigation');
      stopTest();
    }

    window.history.pushState(null, '', href);
    router();
  }
});

// Listen for browser forward/backward navigations
window.addEventListener('popstate', router);

// Render recordings list grid
async function loadRecordingsList() {
  const grid = document.getElementById('sessionsGrid');
  const emptyState = document.getElementById('recordingsEmptyState');

  grid.innerHTML = `
    <div class="loader">
      <div class="loader-spinner"></div>
      <p>Scanning uploads directory for finalized recordings...</p>
    </div>
  `;
  emptyState.style.display = 'none';

  try {
    const response = await fetch('/api/recordings');
    if (!response.ok) {
      throw new Error(`Server responded with: ${response.status} ${response.statusText}`);
    }

    const recordings = await response.json();
    grid.innerHTML = '';

    if (recordings.length === 0) {
      emptyState.style.display = 'block';
      return;
    }

    recordings.forEach(rec => {
      const dateStr = new Date(rec.createdAt).toLocaleString();
      const card = document.createElement('div');
      card.className = 'card glass-card session-card';
      
      card.innerHTML = `
        <div class="session-card-header">
          <span class="session-card-id">${rec.sessionId}</span>
          <span class="session-card-date">Completed: ${dateStr}</span>
        </div>
        <div class="session-card-body">
          <div class="session-metadata">
            <div class="session-meta-row">
              <span class="session-meta-label">Events count:</span>
              <span class="session-meta-value event-badge">${rec.eventCount}</span>
            </div>
            <div class="session-meta-row">
              <span class="session-meta-label">Status:</span>
              <span class="session-meta-value" style="color: var(--color-success);">Ready for Review</span>
            </div>
          </div>
          <a href="/recordings/${rec.sessionId}" class="btn btn-primary btn-sm" data-link style="margin-top: 1rem; width: 100%;">
            🔎 Open Review
          </a>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `
      <div class="card glass-card" style="border-color: var(--color-danger); padding: 1.5rem;">
        <h3 style="color: var(--color-danger);">Failed to load recordings</h3>
        <p style="margin-top: 0.5rem; color: var(--text-secondary);">${err.message}</p>
        <button onclick="loadRecordingsList()" class="btn btn-secondary btn-sm" style="margin-top: 1rem;">Retry</button>
      </div>
    `;
  }
}

// Detailed Review controller
let activeSessionData = null;

async function loadReviewSession(id) {
  const reviewSessionId = document.getElementById('reviewSessionId');
  const reviewVideo = document.getElementById('reviewVideo');
  const reviewEventsList = document.getElementById('reviewEventsList');
  const eventMetadataViewer = document.getElementById('eventMetadataViewer');
  const timelineTrack = document.getElementById('timelineTrack');
  const videoTimeDisplay = document.getElementById('videoTimeDisplay');
  const timelinePlayhead = document.getElementById('timelinePlayhead');

  reviewSessionId.textContent = `Reviewing Session: ${id}`;
  reviewEventsList.innerHTML = `
    <div class="loader">
      <div class="loader-spinner"></div>
      <p>Loading timeline events...</p>
    </div>
  `;
  eventMetadataViewer.innerHTML = '<p class="viewer-placeholder">Select an event from the timeline or the list to view its parameters.</p>';
  reviewVideo.removeAttribute('src');
  
  // Clear previous markers
  const markers = timelineTrack.querySelectorAll('.timeline-marker');
  markers.forEach(m => m.remove());
  timelinePlayhead.style.left = '0%';
  videoTimeDisplay.textContent = '00:00 / 00:00';

  try {
    const response = await fetch(`/api/recordings/${id}`);
    if (!response.ok) {
      throw new Error(`Server responded with: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    activeSessionData = data;

    // Load video stream
    reviewVideo.src = data.videoUrl;
    reviewVideo.load();

    // Fill events list
    renderEventsList(data.events);

    // Render timeline markers once video metadata (duration) becomes available
    reviewVideo.onloadedmetadata = () => {
      setupTimeline(data.events, reviewVideo.duration);
    };

    // Synchronize playhead position and list highlight
    reviewVideo.ontimeupdate = () => {
      syncPlaybackState(reviewVideo.currentTime, reviewVideo.duration);
    };

  } catch (err) {
    reviewEventsList.innerHTML = `
      <div style="padding: 1.5rem; color: var(--color-danger);">
        <h4>Error loading session review</h4>
        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.5rem;">${err.message}</p>
      </div>
    `;
  }
}

// Convert seconds into standard MM:SS
function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Map event types to visual categories
function getEventSeverityClass(type) {
  if (['window_blur', 'visibility_hidden', 'error', 'chunk_upload_failed', 'chunk_upload_network_error'].includes(type)) {
    return 'warn';
  }
  if (['screen_share_started', 'screen_share_stopped', 'recording_started', 'recording_stopped', 'session_completed', 'final_recording_created'].includes(type)) {
    return 'flow';
  }
  return 'interact';
}

function renderEventsList(events) {
  const list = document.getElementById('reviewEventsList');
  list.innerHTML = '';

  events.forEach((event, index) => {
    const item = document.createElement('div');
    item.className = 'event-item';
    item.id = `event-row-${index}`;
    item.setAttribute('data-offset', event.offsetSeconds);

    const timeStr = event.offsetSeconds >= 0 ? formatTime(event.offsetSeconds) : '--:--';
    const severity = getEventSeverityClass(event.type);

    item.innerHTML = `
      <span class="event-item-time">${timeStr}</span>
      <span class="event-item-type">${event.type.replace(/_/g, ' ')}</span>
      <span class="event-item-badge event-badge-${severity}">${severity}</span>
    `;

    item.addEventListener('click', () => {
      selectEvent(event, index);
    });

    list.appendChild(item);
  });
}

function selectEvent(event, index) {
  const reviewVideo = document.getElementById('reviewVideo');
  const eventMetadataViewer = document.getElementById('eventMetadataViewer');

  // Update details viewer
  eventMetadataViewer.innerHTML = `
    <div style="font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.4;">
      <span style="color: var(--color-info); font-weight:600;">Event:</span> ${event.type}
      <span style="color: var(--color-info); font-weight:600;">Offset:</span> ${event.offsetSeconds >= 0 ? event.offsetSeconds + 's' : 'N/A (Before recording)'}
      <span style="color: var(--color-info); font-weight:600;">Timestamp:</span> ${event.timestamp}
      <span style="color: var(--color-info); font-weight:600; display:block; margin-top:0.5rem;">Metadata:</span>
      <pre style="color: #94a3b8; font-size: 0.75rem; white-space: pre-wrap; margin-top: 0.25rem;">${JSON.stringify(event.metadata, null, 2)}</pre>
    </div>
  `;

  // Highlight list row
  const rows = document.querySelectorAll('.event-item');
  rows.forEach(r => r.classList.remove('active'));

  const activeRow = document.getElementById(`event-row-${index}`);
  if (activeRow) {
    activeRow.classList.add('active');
    activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Seek video
  if (event.offsetSeconds >= 0 && reviewVideo.src) {
    reviewVideo.currentTime = event.offsetSeconds;
  }
}

function setupTimeline(events, duration) {
  const timelineTrack = document.getElementById('timelineTrack');
  const timelineContainer = document.getElementById('timelineContainer');
  const reviewVideo = document.getElementById('reviewVideo');

  // Seek on clicking timeline bar
  timelineContainer.onclick = (e) => {
    const rect = timelineTrack.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    reviewVideo.currentTime = percentage * duration;
  };

  // Add markers
  events.forEach((event, index) => {
    if (event.offsetSeconds < 0 || event.offsetSeconds > duration) return;

    const percentage = (event.offsetSeconds / duration) * 100;
    const marker = document.createElement('div');
    const severity = getEventSeverityClass(event.type);

    marker.className = `timeline-marker marker-${severity}`;
    marker.style.left = `${percentage}%`;
    marker.title = `${formatTime(event.offsetSeconds)} - ${event.type}`;

    marker.addEventListener('click', (e) => {
      e.stopPropagation(); // Stop timelineContainer click trigger
      selectEvent(event, index);
    });

    timelineTrack.appendChild(marker);
  });
}

function syncPlaybackState(currentTime, duration) {
  const videoTimeDisplay = document.getElementById('videoTimeDisplay');
  const timelinePlayhead = document.getElementById('timelinePlayhead');

  // Move playhead
  const percentage = duration > 0 ? (currentTime / duration) * 100 : 0;
  timelinePlayhead.style.left = `${percentage}%`;
  videoTimeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;

  // Find and highlight active event closest to playhead
  if (activeSessionData && activeSessionData.events) {
    let closestIdx = -1;
    let minDiff = Infinity;

    activeSessionData.events.forEach((ev, idx) => {
      if (ev.offsetSeconds < 0) return;
      const diff = Math.abs(ev.offsetSeconds - currentTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });

    // Highlight closest event (within a 1.5s tolerance)
    if (closestIdx !== -1 && minDiff < 1.5) {
      const rows = document.querySelectorAll('.event-item');
      rows.forEach(r => r.classList.remove('active'));

      const activeRow = document.getElementById(`event-row-${closestIdx}`);
      if (activeRow && !activeRow.classList.contains('active')) {
        activeRow.classList.add('active');
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        // Update inspector metadata viewer if it is empty/placeholder
        const viewer = document.getElementById('eventMetadataViewer');
        if (viewer.querySelector('.viewer-placeholder')) {
          const event = activeSessionData.events[closestIdx];
          viewer.innerHTML = `
            <div style="font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.4;">
              <span style="color: var(--color-info); font-weight:600;">Event:</span> ${event.type}
              <span style="color: var(--color-info); font-weight:600;">Offset:</span> ${event.offsetSeconds}s
              <span style="color: var(--color-info); font-weight:600;">Timestamp:</span> ${event.timestamp}
              <span style="color: var(--color-info); font-weight:600; display:block; margin-top:0.5rem;">Metadata:</span>
              <pre style="color: #94a3b8; font-size: 0.75rem; white-space: pre-wrap; margin-top: 0.25rem;">${JSON.stringify(event.metadata, null, 2)}</pre>
            </div>
          `;
        }
      }
    }
  }
}

// Initialize router immediately
router();
