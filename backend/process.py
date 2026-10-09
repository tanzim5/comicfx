"""Video -> packed analysis video.

Output is a single H.264 mp4 laid out as a 2x2 grid of luma panels so the
browser only has to decode (and keep in sync) ONE video:

    +-----------+-----------+
    |   color   |   depth   |     depth: 255 = near, 0 = far
    +-----------+-----------+
    |  flow X   |  flow Y   |     128 = no motion
    +-----------+-----------+
"""
import subprocess
import cv2
import numpy as np
import torch
from transformers import AutoImageProcessor, AutoModelForDepthEstimation

MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"
FLOW_RANGE = 24.0  # pixels/frame mapped onto 0..255 around 128

_model = None
_proc = None


def _load():
    global _model, _proc
    if _model is None:
        _proc = AutoImageProcessor.from_pretrained(MODEL_ID)
        _model = AutoModelForDepthEstimation.from_pretrained(MODEL_ID).to("cuda").half().eval()
    return _model, _proc


@torch.no_grad()
def _depth_batch(frames_rgb, out_hw):
    model, proc = _load()
    # Depth Anything wants dims divisible by 14; resize ourselves, skip the processor's resize.
    h, w = out_hw
    ih, iw = (h // 14) * 14, (w // 14) * 14
    x = np.stack([cv2.resize(f, (iw, ih), interpolation=cv2.INTER_AREA) for f in frames_rgb])
    x = torch.from_numpy(x).cuda().permute(0, 3, 1, 2).half() / 255.0
    mean = torch.tensor(proc.image_mean, device="cuda").view(1, 3, 1, 1).half()
    std = torch.tensor(proc.image_std, device="cuda").view(1, 3, 1, 1).half()
    x = (x - mean) / std
    d = model(pixel_values=x).predicted_depth  # (B, ih, iw), bigger = nearer
    d = torch.nn.functional.interpolate(d[:, None].float(), size=(h, w), mode="bilinear")[:, 0]
    return d.cpu().numpy()


def process_video(src, dst, progress=lambda p, msg="": None, max_h=720):
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    sw, sh = int(cap.get(3)), int(cap.get(4))
    scale = min(1.0, max_h / sh)
    w, h = int(sw * scale) // 2 * 2, int(sh * scale) // 2 * 2
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1

    # ---- pass 1: read frames, depth ----
    progress(0.0, "depth")
    frames, depths = [], []
    batch = []

    def flush():
        if batch:
            depths.extend(_depth_batch(batch, (h, w)))
            batch.clear()

    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        bgr = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA)
        frames.append(bgr)
        batch.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        if len(batch) == 8:
            flush()
            progress(0.55 * len(frames) / total, "depth")
    flush()
    cap.release()
    n = len(frames)
    if n == 0:
        raise RuntimeError("no frames decoded")

    # ---- temporal stabilisation: one global range for the clip + EMA ----
    D = np.stack(depths)
    lo, hi = np.percentile(D, 1), np.percentile(D, 99.5)
    D = np.clip((D - lo) / max(hi - lo, 1e-6), 0, 1)
    alpha = 0.55
    for i in range(1, n):
        D[i] = alpha * D[i] + (1 - alpha) * D[i - 1]
    D8 = (D * 255).astype(np.uint8)

    # ---- pass 2: optical flow + pack + encode ----
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
         "-s", f"{w * 2}x{h * 2}", "-r", str(fps), "-i", "-", "-vf", "format=yuv420p",
         "-c:v", "libx264", "-crf", "13", "-preset", "fast", "-g", "6", "-bf", "0",
         "-movflags", "+faststart", dst],
        stdin=subprocess.PIPE)
    prev = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    fw, fh = w // 2, h // 2
    prev_s = cv2.resize(prev, (fw, fh))
    for i in range(n):
        gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
        gray_s = cv2.resize(gray, (fw, fh))
        if i == 0:
            flow = np.zeros((fh, fw, 2), np.float32)
        else:
            flow = cv2.calcOpticalFlowFarneback(prev_s, gray_s, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            flow *= 2.0  # back to full-res pixel units
        prev_s = gray_s
        flow = cv2.resize(flow, (w, h), interpolation=cv2.INTER_LINEAR)
        fx = np.clip(128 + flow[..., 0] / FLOW_RANGE * 127, 0, 255).astype(np.uint8)
        fy = np.clip(128 + flow[..., 1] / FLOW_RANGE * 127, 0, 255).astype(np.uint8)
        # colour panel keeps its colour; data panels are gray (zero chroma) so they
        # survive 4:2:0 subsampling. Only a 1px seam at panel borders can bleed.
        grid = np.empty((h * 2, w * 2, 3), np.uint8)
        grid[:h, :w] = frames[i]
        grid[:h, w:] = D8[i][..., None]
        grid[h:, :w] = fx[..., None]
        grid[h:, w:] = fy[..., None]
        ff.stdin.write(grid.tobytes())
        if i % 8 == 0:
            progress(0.55 + 0.45 * i / n, "motion")
    ff.stdin.close()
    ff.wait()
    progress(1.0, "done")
    return {"fps": fps, "width": w, "height": h, "frames": n}
