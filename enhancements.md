# Proctoring System Enhancements: Event & Video Synchronization

This document summarizes the enhancements implemented to synchronize browser-based proctoring events with screen recording timelines, especially when screen recording starts after the session has initialized.

---

### 1. Absolute Chunk Timeline Anchoring
* **Client-Side:** The chunk uploader in [app.js](file:///media/himanshu/New%20Volume/samta/screen-record-poc/public/app.js) now sends the absolute start timestamp (`absoluteStartTime`) with each WebM chunk multipart upload payload.
* **Server-Side:** [server.js](file:///media/himanshu/New%20Volume/samta/screen-record-poc/server.js) parses this value and persists it inside the session's metadata storage (`chunks_meta.jsonl`).
* **Why it matters:** It couples the video chunks directly with the absolute system clock, creating an immutable baseline timeline.

### 2. Finalization-Resilient Review API
* **Problem:** Once video chunks are finalized and consolidated into `final-recording.webm`, the individual `.webm` files are deleted from the disk to save space. Listing files on the disk returns an empty list, which broke the original timeline calculations.
* **Solution:** Created the `getOrderedChunksMetadata(sessionDir)` helper in `server.js` to read from the JSONL metadata directly. The endpoint `/api/recordings/:sessionId` now establishes the timeline zero anchor (`tZero`) using metadata records, even after the physical chunks are removed.

### 3. Negative Timeline Offset Support
* **Negative Formatting:** Upgraded `formatTime` helper in the UI to support and format negative durations (e.g., `-01:25` for events occurring before recording began).
* **UI Listing:** Allowed events occurring prior to screen recording to render on the event list panel with their negative offset timestamps.
* **Safe Seeks:** Clicking an event with a negative offset now safely resets the video player playhead to `00:00` instead of attempting an out-of-bounds timeline seek.

### 4. Interactive Delay Verification Controls
* **UI Update:** Split the "Start Test" and screen sharing actions in [index.html](file:///media/himanshu/New%20Volume/samta/screen-record-poc/public/index.html) into two buttons:
  * **Start Test:** Generates the Session ID and begins tracking background events immediately.
  * **Start Screen Share:** Can be clicked at a later time to prompt permission overlays and start the `MediaRecorder` pipeline.
* **Why it matters:** Allows developers to easily test delayed screen capture scenarios and verify that events occur correctly relative to the recording.

### 5. Latency Calibration & Clock Calibration
* **MediaRecorder Alignment:** Shipped `recordingStartTime` to the `MediaRecorder.onstart` callback, excluding variable browser permission delays and startup times from the video's start frame clock.
* **High-Resolution Event Offsets:** Modified all DOM event listeners to use `performance.timeOrigin + e.timeStamp` instead of JS-execution-delayed timers. This tracks exact hardware interaction milliseconds.
* **Visual Latency Compensation:** Added a `300ms` calibration constant (`LATENCY_CALIBRATION_MS`) on the review dashboard to align the video player's render frame delay with the event highlight triggers.
