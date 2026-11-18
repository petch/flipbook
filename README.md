# Flipbook Studio

A small, real-time collaborative frame-by-frame animation website. Draw with a mouse, touch, or stylus; invite people with a project URL; make and reorder frames; preview at different frame rates; export a downloadable WebM video (or MP4 if supported by the browser).

## Start locally

Requires **Node.js 18+**. No npm dependencies, databases, accounts, or API keys.

```bash
npm start
```

Open `http://localhost:3000` and click **Create a flipbook**. To test collaboration, open the resulting project link in two browser tabs or share it with someone who can access the server.

To run on a different port:

```bash
PORT=8080 npm start
```

On Windows PowerShell:

```powershell
$env:PORT=8080; npm start
```

## Share with others over the internet

Deploy the Node.js application on an always-on host such as a VPS, Railway, Fly.io, or Render. Configure the start command as `npm start`, expose the assigned `PORT`, and attach a **persistent disk/volume to `data/`** so saved projects survive redeployments. Make sure your hosting service supports server-sent events (SSE) and does not buffer the event stream. Share the hosted project's URL (`https://your-domain/?p=...`).

**Important:** This is an open-by-link MVP without user authentication. Anyone with a project URL can edit or delete its frames. Do not use it for sensitive content or public high-traffic hosting without adding authentication, rate limits, and storage quotas. Use one server instance and a persistent filesystem; multi-instance scaling requires a shared database and pub/sub.

## Features

- Shared projects and automatically saved frame drawings
- Live stroke previews and updates using standard HTTP + Server-Sent Events
- Pen, eraser, color palette/custom color, brush size
- Add, duplicate, clear, delete, and drag-to-reorder frames (max 120)
- Undo most recently added stroke, onion skin, playback, speed 1–24 FPS
- Online collaborator indicators, invite link copying
- Browser-based video export: WebM on Chrome/Edge/Firefox, MP4 when supported
- 960 × 540 16:9 canvas with responsive desktop/mobile layout

## Technical notes

- API and app are served from `server.js`, entirely with Node built-ins (no package installation needed).
- Each animation is a JSON file under `data/`; edits are written atomically.
- Frames store vector strokes. Erasing composites transparent strokes into the frame layer.
- Real-time updates happen via `/api/projects/:id/events` (SSE); writes use POST requests. Draw previews are ephemeral; final strokes are persistent.
- Export uses the browser's `MediaRecorder`, `canvas.captureStream()` and native video encoder. Video export happens locally in the browser and works best in Chrome/Edge. Very short animations repeat to at least ~1.5 seconds. No audio is included.

## Suggested production improvements

Add private rooms/login, role permissions, per-user undo history, image import, layers, audio, timestamps, public gallery, and server-side MP4 encoding; move projects from JSON to a database before scaling beyond one server.
