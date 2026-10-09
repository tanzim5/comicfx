# ComicFX

Hand-drawn style animation overlays for live-action video, built on a depth map.

Drop in a video and ComicFX analyses it on your GPU (depth map + motion field). You then layer
comic-style effects on top — contour strokes that draw themselves on, impact starbursts, zigzag
lightning, glowing swirls, sparkles, speed lines — time them on a timeline, make them follow things in
the footage, and export.

**The original footage is never altered.** Effects are rendered as a separate transparent overlay and
composited onto your *original file* with ffmpeg, so resolution, frame rate and audio come out exactly
as they went in.

```
 your video ──► depth + motion analysis (GPU, once) ──► live preview in the browser
                                                         │  add / place / time / track effects
 your original file ◄── ffmpeg composites ◄── transparent overlay frames ◄── export
```

## Requirements

- Windows 10/11 (macOS/Linux should work too; only `run.bat` is Windows-specific)
- An NVIDIA GPU with CUDA (developed on an RTX 3060 12 GB; the depth model is small)
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/download.html) available on your `PATH` (check with `ffmpeg -version`)
- A Chromium-based browser (Chrome, Edge) for the editor — it needs WebGL2

## Install

```powershell
git clone <this-repo>
cd comicfx

python -m venv .venv
.\.venv\Scripts\activate

# PyTorch with CUDA first (pick the index matching your driver: https://pytorch.org/get-started/locally/)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

pip install -r requirements.txt
```

The first clip you process downloads the depth model (Depth Anything V2 *Small*, ~100 MB) from
Hugging Face once and caches it.

## Run

```powershell
.\run.bat
```

or, on any OS, from the repo root:

```bash
cd backend
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Then open **http://127.0.0.1:8000**.

## Using it

### 1. Add a video
Drag a video anywhere onto the page, or use **+ Add video**. Any `.mp4` you put in the project's root
folder also shows up under **Sample clips**.

The clip appears in the **Library** (left) as a card with a live status: queued → depth map → motion &
pack → ready, with a progress bar and time estimate. The GPU processes one clip at a time; others wait
and say so. Finished clips are remembered between sessions — click a card to open it.

Processing happens once per clip. It runs at up to 720p; your original file is untouched and is used
for the final export.

### 2. Add effects
Click **+ Add effect** (top of the right panel), choose a type, then **click the video** where you want
it. Each effect becomes a layer in the list. Click a layer to edit it.

| Effect | What it does |
|---|---|
| **Contour strokes** | Hand-drawn outlines tracing edges in the footage, with broken strokes, hand wobble, a coloured accent line, and a draw-on reveal (sweep / radial / scribble). |
| **Impact starburst** | A pop-art burst that slams in with halftone shading — good on hits and reveals. |
| **Lightning bolt** | Zigzag bolt with branches and a halftone halo, struck from a start point to an end point. |
| **Glow swirl** | Thin glowing strands spiralling around a point. |
| **Sparkles** | Twinkling four-point glints scattered around a point. |
| **Speed lines** | Radial manga action lines bursting from a point. |

### 3. Place, time and track
For the selected layer:

- **Place on video** — click the video to set its position. **Set end point** (bolt) sets where the
  strike ends; you can also **Alt+click** the video.
- **Follow footage** — tracks the point you placed through the clip so the effect sticks to what's
  moving (a pen tip, a hand, a face). Place the effect on the frame where you want it to start, then
  turn this on, or re-place it with Follow already on.
- **Timing** — *Start*, *Length*, *Draw-on time* (how long the effect takes to animate in) and
  *Fade-out*. You can also drag the layer's bar on the **timeline** under the player: drag the middle to
  move, the edges to resize, click empty track to jump the playhead.
- **Hand-drawn fps** — the effect re-draws at this rate (default 12) for the "animated on twos" look,
  while the video underneath keeps playing at its normal frame rate.
- **Reroll look** — new random seed (different jag, spike pattern, stroke breakup).

### 4. Use depth
The depth map is what makes this more than a flat overlay:

- **Hide behind subject** — the effect disappears wherever something nearer than *Subject depth* is in
  front of it, so bolts and speed lines can sit behind a person.
- **Pick subject from video** — click the subject and ComicFX reads its depth. For contour strokes this
  sets the depth band to trace (otherwise the nearest object wins — often a hand in the foreground);
  for other effects it sets the "hide behind" cutoff.
- **Trace from depth / Trace up to** (contour strokes) — restrict strokes to a depth band by hand.

### 5. Preview helpers
- **Composite / Overlay / Depth / Flow** (below the player) — see the final result, the effects alone,
  the depth map, or the motion field.
- **Compare** — drag a divider to see the original on the left and the result on the right.

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `C` | Toggle compare |
| `Esc` | Cancel placing |
| `Delete` | Remove selected layer |

Your layers are saved automatically per clip in the browser (`localStorage`), so reopening a clip brings
them back. They are **not** stored in the repo or on the server.

### 6. Export
**Export MP4** (top right) renders every frame of the overlay and composites it onto your original
file. The result downloads as `<name>_comic.mp4` with the original's resolution, frame rate and audio
stream (copied, not re-encoded). Video is re-encoded once (H.264, CRF 12) because the overlay has to
be burned in.

Keep the tab visible while exporting — browsers throttle hidden tabs.

## Tips

- **Subtle beats busy.** The references this was modelled on use few, well-timed elements. Start with
  one effect, lower *Sensitivity* / *Strength*, and time it to the action.
- Strokes too thick or too busy? Raise *Sensitivity* (fewer edges), lower *Line width*, raise
  *Broken strokes*.
- Effect looks stuck in front of something it should be behind? Use **Pick subject from video**.
- A tracked effect drifts? Re-place it on a frame closer to where the drift starts; tracking is a
  single-point optical-flow follow, not a full object tracker.

## How it works

1. **Analysis** (`backend/process.py`): each frame goes through Depth Anything V2 Small (fp16, CUDA).
   Depth is normalised once per clip and lightly smoothed over time to reduce flicker. Optical flow
   (OpenCV Farneback) gives per-pixel motion. Colour, depth and flow are packed into **one** H.264
   video (a 2×2 grid) so the browser decodes a single stream and everything stays in sync.
2. **Editor** (`web/`): WebGL2. Each effect type is a fragment shader that outputs a premultiplied,
   transparent overlay; layers are drawn over the footage in list order. The depth/flow panels are
   sampled in the shaders for masks, occlusion and edge detection.
3. **Tracking** (`/api/track`): pyramidal Lucas-Kanade on a 3×3 patch around your point, walked forward
   and backward from the frame you placed it on.
4. **Export**: the browser steps through the clip frame by frame, renders the overlay-only frame, and
   sends raw RGBA to the server, which pipes it into ffmpeg over the original file.

### Project layout

```
backend/
  server.py     FastAPI app: jobs/library, tracking, export, serves the web UI
  process.py    depth + optical flow + packing
web/
  index.html    layout
  style.css     styling
  layers.js     effect shaders and their control schemas  <- add new effects here
  app.js        editor: GL engine, layers, timeline, library, export
run.bat         Windows launcher
requirements.txt
work/           generated at runtime (processed clips, thumbnails, exports) — git-ignored
```

### Adding a new effect
Add an entry to `TYPES` in `web/layers.js`: a `params` list (generates the sliders/colour pickers and
the GLSL uniforms automatically) and a `glsl` string defining `vec4 fx(vec2 uv, vec2 A)` that returns
**premultiplied** RGBA. Helpers available in every shader: `C(uv)` colour, `D(uv)` depth, `sobL`/`sobD`
edge filters, `fbm`/`vn` noise, `ease`, `over`, plus `uPos`, `uP2`, `uP` (draw-on progress), `uStep`
(hand-drawn step index) and `uSeed`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `ffmpeg` not found / export fails instantly | Install ffmpeg and make sure `ffmpeg -version` works in the same terminal that runs the server. |
| `torch.cuda.is_available()` is `False` | Reinstall PyTorch with a CUDA build matching your driver (see Install). |
| A clip sits on "Queued" | Another clip is on the GPU; it will start when that one finishes. |
| Effect shows "failed to compile" | Open the browser console — the GLSL error is logged. |
| Export is slow | Keep the tab in the foreground. Cost scales with frame count × resolution. |
| Out of GPU memory | Lower `max_h` in `backend/process.py` (default 720). |

## Limitations

- Single-point tracking only; no face/landmark tracking yet (e.g. outlining eyes or a mask).
- One GPU job at a time.
- Clips are analysed at up to 720p; effects are rendered at that size and scaled up to your original
  resolution on export, so very fine strokes will be slightly soft on 4K sources.
- The whole clip's grayscale frames are held in memory while tracking, which is fine for short clips
  but heavy for long ones.

## Credits

Depth estimation: [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) (Small
variant, via 🤗 Transformers). Check the model's licence before commercial use.
