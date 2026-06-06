// State Management
let sessionId = null;
let stream = null;
let mediaRecorder = null;
let chunkIndex = 0;
let isActive = false;
let currentTab = 'chunks'; // 'chunks' or 'events'
let chunkInterval = null; // Timer to capture and restart recording chunks
let recordingStartTime = null;

// DOM Elements
const startTestBtn = document.getElementById('startTestBtn');
const startScreenShareBtn = document.getElementById('startScreenShareBtn');
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
async function logEvent(type, metadata = {}, clientTimestamp = null) {
  const timestamp = clientTimestamp || new Date().toISOString();
  const timeStr = new Date(timestamp).toLocaleTimeString();

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

    // Enable next action button
    startScreenShareBtn.disabled = false;
    stopTestBtn.disabled = false;
  } catch (err) {
    await logEvent('error', { message: err.message, name: err.name });
    alert(`Failed to start session: ${err.message || err}`);
    resetUI();
  }
});

// Start Screen Share Handler
startScreenShareBtn.addEventListener('click', async () => {
  try {
    startScreenShareBtn.disabled = true;
    
    // 1. Request Display Stream
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

    // 2. Show stream in UI Video Element
    previewVideo.srcObject = stream;
    previewVideo.style.display = 'block';
    videoPlaceholder.style.display = 'none';
    
    // Update UI Indicators
    screenShareIndicator.className = 'status-badge status-active';
    screenShareIndicator.textContent = 'Screen Share Active';

    // 3. Detect user stopping screen share via Chrome native overlay controls
    if (videoTrack) {
      videoTrack.onended = () => {
        logEvent('screen_share_stopped', { reason: 'User clicked browser native overlay Stop button' });
        stopTest();
      };
    }

    // 4. Initialize MediaRecorder helper
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

    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder = recorder;

    let nextChunkStart = 0;

    recorder.onstart = () => {
      recordingStartTime = Date.now();
      logEvent('recording_started', { mimeType }, new Date(recordingStartTime).toISOString());
    };

    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        chunkIndex++;
        const currentChunk = chunkIndex;
        const chunkStart = nextChunkStart;
        const baseTime = recordingStartTime || Date.now();
        const chunkEnd = parseFloat(((Date.now() - baseTime) / 1000).toFixed(3));
        nextChunkStart = chunkEnd;

        await logEvent('chunk_captured', { chunkIndex: currentChunk, sizeBytes: e.data.size, startTime: chunkStart, endTime: chunkEnd });
        await uploadChunk(e.data, currentChunk, chunkStart, chunkEnd);
      }
    };

    recorder.start(5000);

    // Periodically verify the screen track is still alive while the recorder emits chunks.
    chunkInterval = setInterval(() => {
      // Fail-safe: Detect if the user stopped screen sharing from the browser UI
      const track = stream ? stream.getVideoTracks()[0] : null;
      if (!track || track.readyState === 'ended') {
        logEvent('screen_share_stopped', { reason: 'Detected ended track state via interval timer' });
        stopTest();
        return;
      }
    }, 5000);
    
    // Update UI Indicators
    recordingIndicator.className = 'status-badge status-recording';
    recordingIndicator.textContent = 'Recording (5s Chunks)';
  } catch (err) {
    await logEvent('error', { message: err.message, name: err.name });
    alert(`Failed to start screen share/recording: ${err.message || err}`);
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
  startScreenShareBtn.disabled = true;
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
  startScreenShareBtn.disabled = true;
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
async function uploadChunk(blob, index, startTime, endTime) {
  try {
    // IMPORTANT: Form data layout matters. Append text/string fields BEFORE the file blob
    // so multer's diskStorage destination callback can properly parse req.body.sessionId.
    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('chunkIndex', String(index));
    formData.append('startTime', String(startTime));
    formData.append('endTime', String(endTime));
    
    // Calculate and append the absolute start timestamp of the chunk
    const absStart = recordingStartTime ? (recordingStartTime + Math.round(startTime * 1000)) : Date.now();
    formData.append('absoluteStartTime', String(absStart));
    
    formData.append('recording', blob, `chunk-${index}.webm`);

    const response = await fetch('/api/recording/chunk', {
      method: 'POST',
      body: formData
    });

    if (response.ok) {
      const data = await response.json();
      await logEvent('chunk_uploaded', { chunkIndex: index, startTime, endTime, serverPath: data.path });
      
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

function getEventTimestamp(e) {
  if (e && typeof e.timeStamp === 'number' && performance.timeOrigin) {
    return new Date(performance.timeOrigin + e.timeStamp).toISOString();
  }
  return new Date().toISOString();
}

// Event Listeners for Proctoring Details

// 1. Focus & Blur
window.addEventListener('focus', (e) => {
  if (isActive) logEvent('window_focus', {}, getEventTimestamp(e));
});
window.addEventListener('blur', (e) => {
  if (isActive) logEvent('window_blur', {}, getEventTimestamp(e));
});

// 2. Tab/Page Visibility Change
document.addEventListener('visibilitychange', (e) => {
  if (isActive) {
    const visibilityState = document.visibilityState;
    logEvent(`visibility_${visibilityState}`, { state: visibilityState }, getEventTimestamp(e));
  }
});

// 3. Window Resize
window.addEventListener('resize', (e) => {
  if (isActive) {
    logEvent('resize', {
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    }, getEventTimestamp(e));
  }
});

// 4. Clipboard Interceptions (Copy/Paste)
document.addEventListener('copy', (e) => {
  if (isActive) {
    const selectedText = window.getSelection() ? window.getSelection().toString() : '';
    logEvent('copy', {
      charCount: selectedText.length,
      snippet: selectedText.substring(0, 30)
    }, getEventTimestamp(e));
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
    }, getEventTimestamp(e));
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
    }, getEventTimestamp(e));
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
let currentSessionDuration = 0;
const eventReviewState = {
  events: [],
  query: '',
  selectedType: 'all'
};

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
  currentSessionDuration = 0;

  try {
    const response = await fetch(`/api/recordings/${id}`);
    if (!response.ok) {
      throw new Error(`Server responded with: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Calibrate events timeline for visual video encoder/capture lag
    const LATENCY_CALIBRATION_MS = 300; 
    data.events = data.events.map(ev => {
      // Only calibrate positive offsets (the recorded video portion)
      if (ev.offsetSeconds >= 0) {
        ev.offsetSeconds = parseFloat((ev.offsetSeconds - (LATENCY_CALIBRATION_MS / 1000)).toFixed(3));
      }
      return ev;
    });

    activeSessionData = data;

    // Load video stream
    reviewVideo.src = data.videoUrl;
    reviewVideo.load();

    initializeEventReviewPanel(data.events);

    // Setup loadedmetadata logic to handle missing duration / Infinity
    reviewVideo.onloadedmetadata = () => {
      const initializeTimeline = (finalDuration) => {
        currentSessionDuration = finalDuration;
        setupTimeline(data.events, currentSessionDuration);
        
        // Register timeupdate listener only after duration is established
        reviewVideo.ontimeupdate = () => {
          syncPlaybackState(reviewVideo.currentTime, currentSessionDuration);
        };
      };

      let duration = reviewVideo.duration;

      if (!isFinite(duration) || isNaN(duration) || duration <= 0) {
        // Seek workaround to force browser to parse index/metadata
        reviewVideo.currentTime = 1e10;
        
        reviewVideo.addEventListener('seeked', function onSeeked() {
          reviewVideo.removeEventListener('seeked', onSeeked);
          reviewVideo.currentTime = 0;
          
          let durationAfterSeek = reviewVideo.duration;
          if (!isFinite(durationAfterSeek) || isNaN(durationAfterSeek) || durationAfterSeek <= 0) {
            // Fallback: use the offset of the last event
            const lastEvent = data.events[data.events.length - 1];
            durationAfterSeek = lastEvent && lastEvent.offsetSeconds > 0 ? lastEvent.offsetSeconds : 0;
          }
          initializeTimeline(durationAfterSeek);
        }, { once: true });
      } else {
        initializeTimeline(duration);
      }
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
  if (isNaN(seconds)) return '00:00';
  const isNegative = seconds < 0;
  const absSeconds = Math.abs(seconds);
  const mins = Math.floor(absSeconds / 60);
  const secs = Math.floor(absSeconds % 60);
  const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return isNegative ? `-${formatted}` : formatted;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function humanizeEventType(type) {
  return String(type || 'event')
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getEventTypeGroup(type) {
  if (['window_blur', 'visibility_hidden', 'visibility_visible', 'window_focus'].includes(type)) {
    return 'navigation';
  }
  if (['copy', 'paste', 'keydown'].includes(type)) {
    return 'key_press';
  }
  if (['screen_share_started', 'screen_share_stopped', 'screen_share_surface_detected', 'requesting_screen_share'].includes(type)) {
    return 'screen_share';
  }
  if (['recording_started', 'recording_stopped', 'chunk_captured', 'chunk_uploaded', 'final_recording_created', 'session_initialized', 'session_completed', 'test_ended_by_user', 'test_ended_by_navigation'].includes(type)) {
    return 'system';
  }
  if (['error', 'chunk_upload_failed', 'chunk_upload_network_error'].includes(type)) {
    return 'violation';
  }
  return 'system';
}

function getEventGroupLabel(group) {
  const labels = {
    all: 'All',
    violation: 'Violations',
    key_press: 'Key Presses',
    navigation: 'Navigation',
    screen_share: 'Screen Share',
    system: 'System'
  };
  return labels[group] || humanizeEventType(group);
}

function getEventSeverity(type) {
  if (['window_blur', 'visibility_hidden', 'screen_share_stopped', 'error', 'chunk_upload_failed', 'chunk_upload_network_error'].includes(type)) {
    return 'High';
  }
  if (['copy', 'paste', 'screen_share_surface_detected', 'test_ended_by_navigation'].includes(type)) {
    return 'Medium';
  }
  return 'Low';
}

function getEventDescription(event) {
  const metadata = event.metadata || {};
  const descriptions = {
    session_initialized: 'Session initialized for review recording.',
    requesting_screen_share: 'Candidate was prompted to share the entire screen.',
    screen_share_surface_detected: `Shared surface detected: ${metadata.displaySurface || 'unknown'}.`,
    screen_share_started: 'Screen sharing started successfully.',
    screen_share_stopped: 'Candidate stopped screen sharing.',
    recording_started: 'Screen recording started.',
    recording_stopped: 'Screen recording stopped.',
    session_completed: 'Session was completed.',
    test_ended_by_user: 'Candidate ended the test session.',
    test_ended_by_navigation: 'Session ended because candidate navigated away.',
    window_blur: 'Focus moved away from the test window.',
    window_focus: 'Focus returned to the test window.',
    visibility_hidden: 'Test tab became hidden.',
    visibility_visible: 'Test tab became visible.',
    copy: `Copy attempt detected${metadata.charCount ? ` (${metadata.charCount} chars)` : ''}.`,
    paste: `Paste attempt detected${metadata.charCount ? ` (${metadata.charCount} chars)` : ''}.`,
    keydown: metadata.key ? `Key press captured: ${metadata.key}.` : 'Keyboard activity detected.',
    resize: 'Browser window size changed.',
    chunk_captured: `Recording chunk ${metadata.chunkIndex || ''} captured.`.trim(),
    chunk_uploaded: `Recording chunk ${metadata.chunkIndex || ''} uploaded.`.trim(),
    chunk_upload_failed: 'Recording chunk upload failed.',
    chunk_upload_network_error: 'Network error during chunk upload.',
    final_recording_created: 'Final review video was generated.',
    error: metadata.message || 'Client error recorded.'
  };
  return descriptions[event.type] || `${humanizeEventType(event.type)} event captured.`;
}

function getEventPresentation(event) {
  const group = getEventTypeGroup(event.type);
  return {
    group,
    groupLabel: getEventGroupLabel(group),
    label: humanizeEventType(event.type),
    severity: getEventSeverity(event.type),
    description: getEventDescription(event)
  };
}

// Map event types to visual categories for timeline markers.
function getEventSeverityClass(type) {
  if (['window_blur', 'visibility_hidden', 'error', 'chunk_upload_failed', 'chunk_upload_network_error'].includes(type)) {
    return 'warn';
  }
  if (['screen_share_started', 'screen_share_stopped', 'recording_started', 'recording_stopped', 'session_completed', 'final_recording_created'].includes(type)) {
    return 'flow';
  }
  return 'interact';
}

function initializeEventReviewPanel(events) {
  eventReviewState.events = events || [];
  eventReviewState.query = '';
  eventReviewState.selectedType = 'all';

  const searchInput = document.getElementById('eventSearchInput');
  const typeFilter = document.getElementById('eventTypeFilter');
  if (searchInput) searchInput.value = '';
  if (typeFilter) typeFilter.value = 'all';

  renderEventTypeFilters();
  renderEventsList();
}

function getEventTypeCounts() {
  const counts = { all: eventReviewState.events.length };
  eventReviewState.events.forEach(event => {
    const group = getEventTypeGroup(event.type);
    counts[group] = (counts[group] || 0) + 1;
  });
  return counts;
}

function renderEventTypeFilters() {
  const chips = document.getElementById('eventTypeChips');
  const typeFilter = document.getElementById('eventTypeFilter');
  const counts = getEventTypeCounts();
  const orderedTypes = ['all', 'violation', 'key_press', 'navigation', 'screen_share', 'system']
    .filter(type => type === 'all' || counts[type]);

  if (typeFilter) {
    typeFilter.innerHTML = orderedTypes
      .map(type => `<option value="${type}">${getEventGroupLabel(type)}</option>`)
      .join('');
    typeFilter.value = eventReviewState.selectedType;
  }

  if (!chips) return;
  chips.innerHTML = orderedTypes
    .map(type => `
      <button class="event-type-chip chip-${type}${eventReviewState.selectedType === type ? ' active' : ''}" type="button" data-event-type="${type}">
        ${getEventGroupLabel(type)}
        <span>${counts[type] || 0}</span>
      </button>
    `)
    .join('');
}

function getFilteredEvents() {
  const query = eventReviewState.query.trim().toLowerCase();

  return eventReviewState.events
    .map((event, index) => ({ event, index, presentation: getEventPresentation(event) }))
    .filter(({ event, presentation }) => {
      if (eventReviewState.selectedType !== 'all' && presentation.group !== eventReviewState.selectedType) {
        return false;
      }

      if (!query) return true;

      const haystack = [
        event.type,
        presentation.label,
        presentation.groupLabel,
        presentation.severity,
        presentation.description,
        event.timestamp,
        JSON.stringify(event.metadata || {})
      ].join(' ').toLowerCase();

      return haystack.includes(query);
    });
}

function renderEventsList() {
  const list = document.getElementById('reviewEventsList');
  const footer = document.getElementById('eventsListFooter');
  const filteredEvents = getFilteredEvents();
  list.innerHTML = '';

  if (footer) {
    const total = eventReviewState.events.length;
    footer.textContent = `${filteredEvents.length} of ${total} events`;
  }

  if (filteredEvents.length === 0) {
    list.innerHTML = `
      <div class="event-empty-state">
        <strong>No events found</strong>
        <span>Try a different search or event type.</span>
      </div>
    `;
    return;
  }

  filteredEvents.forEach(({ event, index, presentation }) => {
    const item = document.createElement('div');
    item.className = 'event-item';
    item.id = `event-row-${index}`;
    item.setAttribute('data-offset', event.offsetSeconds);

    const timeStr = formatTime(event.offsetSeconds);
    const severityKey = presentation.severity.toLowerCase();

    item.innerHTML = `
      <button class="event-play-btn" type="button" aria-label="Jump to ${escapeHtml(timeStr)}">▶</button>
      <span class="event-item-time">${escapeHtml(timeStr)}</span>
      <span class="event-item-type">
        <span class="event-type-icon event-icon-${presentation.group}"></span>
        ${escapeHtml(presentation.label)}
      </span>
      <span class="event-item-badge event-badge-${severityKey}">${escapeHtml(presentation.severity)}</span>
      <span class="event-item-description">${escapeHtml(presentation.description)}</span>
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
  const presentation = getEventPresentation(event);

  // Update details viewer
  eventMetadataViewer.innerHTML = `
    <div style="font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.4;">
      <span style="color: var(--color-info); font-weight:600;">Event:</span> ${escapeHtml(presentation.label)}
      <span style="color: var(--color-info); font-weight:600;">Offset:</span> ${escapeHtml(event.offsetSeconds + 's')}
      <span style="color: var(--color-info); font-weight:600;">Timestamp:</span> ${escapeHtml(event.timestamp)}
      <span style="color: var(--color-info); font-weight:600; display:block; margin-top:0.5rem;">Metadata:</span>
      <pre style="color: #94a3b8; font-size: 0.75rem; white-space: pre-wrap; margin-top: 0.25rem;">${escapeHtml(JSON.stringify(event.metadata, null, 2))}</pre>
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
  if (reviewVideo.src) {
    reviewVideo.currentTime = Math.max(0, event.offsetSeconds || 0);
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
          const presentation = getEventPresentation(event);
          viewer.innerHTML = `
            <div style="font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.4;">
              <span style="color: var(--color-info); font-weight:600;">Event:</span> ${escapeHtml(presentation.label)}
              <span style="color: var(--color-info); font-weight:600;">Offset:</span> ${escapeHtml(event.offsetSeconds + 's')}
              <span style="color: var(--color-info); font-weight:600;">Timestamp:</span> ${escapeHtml(event.timestamp)}
              <span style="color: var(--color-info); font-weight:600; display:block; margin-top:0.5rem;">Metadata:</span>
              <pre style="color: #94a3b8; font-size: 0.75rem; white-space: pre-wrap; margin-top: 0.25rem;">${escapeHtml(JSON.stringify(event.metadata, null, 2))}</pre>
            </div>
          `;
        }
      }
    }
  }
}

document.getElementById('eventSearchInput')?.addEventListener('input', (e) => {
  eventReviewState.query = e.target.value;
  renderEventsList();
});

document.getElementById('eventTypeFilter')?.addEventListener('change', (e) => {
  eventReviewState.selectedType = e.target.value;
  renderEventTypeFilters();
  renderEventsList();
});

document.getElementById('eventTypeChips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-event-type]');
  if (!chip) return;
  eventReviewState.selectedType = chip.getAttribute('data-event-type') || 'all';
  const typeFilter = document.getElementById('eventTypeFilter');
  if (typeFilter) typeFilter.value = eventReviewState.selectedType;
  renderEventTypeFilters();
  renderEventsList();
});

// Initialize router immediately
router();
