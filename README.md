# Flipbook Studio 2

A dependency-free Node.js website for collaborative, frame-by-frame 2D animation. Works with mouse, stylus, or touch. Projects are shared by URL and automatically saved locally as JSON.

## Start locally

Requires **Node.js 18+**. No npm installation or API keys required.

```bash
npm start
```

Open **http://localhost:3000**. Create a project and share its URL. For a different port, set the `PORT` environment variable.

## Deploy on Render (free Web Service)

1. Upload **the contents of this folder** to a GitHub repository, so `package.json` and `server.js` are in the repository root.
2. In [Render Dashboard](https://dashboard.render.com/web/new), create a **Web Service** connected to that repository.
3. Choose **Node**, **Free**, **Build command:** `npm install`, **Start command:** `npm start`.
4. Visit the public `*.onrender.com` URL and share the project link.

**Data warning:** Render Free has an ephemeral filesystem. `data/*.json` files **can be lost on idle shutdowns, redeployments, and restarts**. This edition is suitable for temporary experiments, not persistent shared projects on Render Free. For permanent hosting, add an external database or storage service. Export before leaving your work unattended.

## Editing features

- Brush (`B`), eraser (`E`), flood-fill bucket (`G`), lasso select/move (`L`)
- Lasso: draw a closed-looking freehand outline around strokes or imported images; drag the selection to move. Duplicate, delete, and deselect selected items using the left toolbar. A selection moves **whole strokes/images**, not individual pixels within a stroke.
- Image import: PNG/JPEG/WebP/GIF (GIF **first frame only**). Images are converted to WebP or PNG, automatically resized and embedded into the shared project. Use Lasso to reposition. Max compressed image data ~1.6 MB.
- Undo / redo for brush strokes, erasing, fills, imported images, lasso moves, selection edits, frame clear, and tween generation. `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z` or buttons. History is local to the browser session, and collaboration conflicts are still possible for full-frame edits.
- Touch canvas: **two-finger quick tap = undo**, **three-finger quick tap = redo**. Drag one finger to draw. Gesture recognition requires touches to remain mostly stationary, and browser/OS gestures can interfere.
- Adjustable onion skins: independently show **0–5 previous** and **0–5 next** frames.
- Add/duplicate/delete/reorder frames; 1–24 FPS preview; max 120 total frames.

## Shape-tween generator

Draw two **adjacent keyframes** and select the first. Choose number of in-betweens, an easing preset or **Custom Bézier** curve (X1/Y1/X2/Y2 handles), then click **Generate in-betweens**.

The generator **bakes editable 2D in-between frames** by matching strokes **in drawing order**, resampling vector paths, and blending points, color, and brush size. Imported identical images interpolate position and scale; different images cross-fade. This is **vector shape tweening**, not 3D skeletal blend shapes, automatic object tracking, or live procedural keyframe links. For best results, keep corresponding drawings and stroke order similar in both keyframes. Generated frames can then be edited individually.

## Export formats

Select a format in the top-right dropdown, then click **Export**:

| Format | Notes |
|---|---|
| WebM | 960×540, browser MediaRecorder, Chrome/Edge recommended |
| MP4 | 960×540, **only if the browser supports MP4 MediaRecorder** |
| Animated GIF | 480×270, 256-color palette, loops |
| PNG sequence ZIP | Separate full-resolution 960×540 PNG per frame |
| PNG sprite sheet | 480×270 per frame in a packed grid |

Video recordings are made in **real time**, and very short animations repeat to reach approximately 1.5 seconds. Exporting is performed locally in your browser. Audio is not included. Large animations and GIF export consume memory and may take longer.

## Technical notes and limits

- Vanilla HTML/CSS/JS frontend + Node built-in HTTP server; zero external npm dependencies.
- Persisted drawings consist of vector strokes and embedded raster images in `data/<project-id>.json`.
- Server-Sent Events (SSE) broadcast stroke operations and presence; HTTP POST saves operations.
- Project links grant **full edit access** to anyone who possesses them; no accounts, roles, moderation, rate limits, or storage quotas.
- Multiple artists editing the same stroke/frame simultaneously can conflict. For a public site, use authenticated access and transactional persistent storage.
