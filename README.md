# IntegrityProctor - Browser-Based Test Proctoring POC

A working Proof of Concept (POC) demonstrating how a browser-based test proctoring platform can request screen sharing permissions, capture screen video in chunks, upload chunks incrementally to a Node.js backend every 5 seconds, and log critical window/page focus and input events.

---

## 🏗️ Tech Stack

- **Frontend**: Plain HTML5, custom CSS3 (dark glassmorphic design), Vanilla JavaScript.
- **Backend**: Node.js, Express framework, Multer for multipart form data storage.
- **Storage**: Local filesystem storage (organized by `sessionId`).

---

## 📂 Project Structure

```txt
screen-recording-poc/
  ├── package.json         # Project metadata and dependencies
  ├── server.js            # Node/Express backend configuration
  ├── public/              # Static frontend assets
  │   ├── index.html       # Webpage layout and UI
  │   ├── app.js           # MediaRecorder and user event handling
  │   └── styles.css       # Premium CSS styling
  └── uploads/             # Stores session folders dynamically
      └── .gitkeep         # Keeps directory in VCS
```

---
 
## 🚀 How to Run

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the application**:
   ```bash
   npm start
   ```

3. **Open the application**:
   Open [http://localhost:3000](http://localhost:3000) in your web browser (Chrome/Edge/Firefox).

---

## 🔌 API Endpoints

The backend exposes these core routes:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/recording/chunk` | Accepts `multipart/form-data` with fields `sessionId`, `chunkIndex`, and file `recording` (.webm). Stores in `uploads/<sessionId>/chunk-XXXXXX.webm`. |
| `POST` | `/api/proctoring/event` | Accepts JSON body containing session logs. Appends events to `uploads/<sessionId>/events.jsonl` (one JSON line per event). |
| `GET` | `/api/session/:sessionId/chunks` | Lists files and size metadata of uploaded chunks for the session. |
| `GET` | `/api/session/:sessionId/events` | Reads and parses the JSONL file to return all registered events for the session. |

---

## 🧪 Manual Verification Steps

Follow these steps to verify that the POC operates correctly:

1. **Initialize Session**:
   - Open [http://localhost:3000](http://localhost:3000).
   - Click **Start Test**.

2. **Select Screen share**:
   - A screen-sharing permission dialogue will pop up. Select a window or entire screen.
   - The UI header warning will prompt you. A live feed of your screen sharing will display under **Live Proctoring Stream**.

3. **Verify Uploads**:
   - Keep the test running. Every 5 seconds, watch the **Activity & Event Log** panel.
   - You should see `CHUNK_CAPTURED` and `CHUNK_UPLOADED` logs.
   - Navigate to the project root directory and inspect `uploads/<your-session-id>/`. You will see `chunk-000001.webm`, `chunk-000002.webm`, etc., populating sequentially.

4. **Verify Proctoring Event Listeners**:
   - Click away from the page (unfocus). See `WINDOW_BLUR` and `VISIBILITY_HIDDEN` logged.
   - Refocus the browser window. See `WINDOW_FOCUS` and `VISIBILITY_VISIBLE` logged.
   - Resize the browser window. See `RESIZE` logs detailing new dimensions.
   - Highlight text on the page and press `Ctrl+C` (copy) or `Ctrl+V` (paste). Check console logs for `COPY` and `PASTE` events.
   - Press keys inside the document context. Check console logs for `KEYDOWN` details.

5. **Stop Screen Share via Browser**:
   - Click the native browser overlay button "Stop sharing".
   - Confirm the recording turns off automatically and logs `SCREEN_SHARE_STOPPED`.

6. **Verify Endpoints inside App**:
   - In the **Backend Upload Inspector** card, click **Fetch Uploaded Chunks** to verify the list returns from the backend `/api/session/:sessionId/chunks` API.
   - Click **Fetch Server Log (.jsonl)** to read the structured event logs from the backend.

---

## ⚠️ Important Browser Constraints

1. **Explicit Permission Required**: Screen sharing can *only* be started inside user-triggered handlers (e.g. click). The browser restricts starting screen shares programmatically without user action.
2. **Audio Track Fallback**: Standard browser security may reject display audio selection based on platform. If `audio: true` causes errors, the script falls back to video-only.
3. **No Screen Boundaries Enforcement**: Web applications cannot prevent a user from selecting a single tab/window instead of the entire screen. The POC issues a warning to instruct users to choose the full desktop.
4. **Recording Context Duration**: MediaRecorder `ondataavailable` captures periodic chunks. To prevent buffer leaks, the chunks are sent directly to the server rather than accumulating in browser memory.

---

## 📈 Next Production Improvements

1. **Authentication and Authorization**: Add JWT security headers to requests to verify that chunks are being written by authorized test-takers.
2. **Database Migration**: Move events logging from plain text `.jsonl` files to databases like MongoDB or PostgreSQL for rapid querying and search indexing.
3. **Cloud Storage Integration**: Pipe uploads directly into cloud buckets (AWS S3, Google Cloud Storage) using write-streams instead of storing chunks on local server hard drives.
4. **Automated Flagging Engine**: Construct automated workers that read the `events.jsonl` logs (e.g. flagging sessions with excessive `window_blur` or missing chunks).
5. **Video Stitching Worker**: Set up a server-side runner (using FFmpeg) that joins the individual WebM chunks into a single fluid playback recording once the session state changes to completed.
