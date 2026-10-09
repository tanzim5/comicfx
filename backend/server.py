import json
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

import cv2
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
WORK.mkdir(exist_ok=True)
WEB = ROOT / "web"
LIB = WORK / "library.json"

app = FastAPI()
jobs: dict[str, dict] = {}
sources: dict[str, Path] = {}
gpu_lock = threading.Lock()


def _save_lib():
    LIB.write_text(json.dumps([j for j in jobs.values() if j["status"] == "done"]))


def _load_lib():
    if LIB.exists():
        for j in json.loads(LIB.read_text()):
            if (WORK / f"{j['id']}.mp4").exists():
                jobs[j["id"]] = j
                if j.get("src"):
                    sources[j["id"]] = Path(j["src"])
                elif j.get("key", "").startswith("sample:"):  # library from before src was stored
                    sources[j["id"]] = ROOT / j["key"].split(":")[1]


_load_lib()


def _thumb(src: Path, dst: Path):
    if dst.exists():
        return
    cap = cv2.VideoCapture(str(src))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * 0.2))
    ok, f = cap.read()
    cap.release()
    if ok:
        h, w = f.shape[:2]
        f = cv2.resize(f, (480, int(480 * h / w)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(dst), f, [cv2.IMWRITE_JPEG_QUALITY, 85])


def _run(job_id: str):
    job = jobs[job_id]
    dst = WORK / f"{job_id}.mp4"

    def progress(p, stage=""):
        job["progress"], job["stage"] = p, stage

    try:
        with gpu_lock:  # one clip on the GPU at a time; others show "queued"
            job.update(status="running", stage="loading", started=time.time())
            from process import process_video  # lazy import: torch takes a few seconds
            info = process_video(str(sources[job_id]), str(dst), progress)
        job.update(status="done", stage="done", progress=1.0, info=info,
                   url=f"/work/{job_id}.mp4", finished=time.time())
        _save_lib()
    except Exception as e:
        job.update(status="error", error=repr(e))


def _start(src: Path, name: str, key: str):
    for j in jobs.values():  # already processed (or in flight): reuse it
        if j.get("key") == key and j["status"] in ("done", "queued", "running"):
            return {"id": j["id"]}
    job_id = uuid.uuid4().hex[:10]
    sources[job_id] = src
    _thumb(src, WORK / f"{job_id}.jpg")
    jobs[job_id] = {"id": job_id, "name": name, "key": key, "src": str(src), "status": "queued", "stage": "queued",
                    "progress": 0.0, "thumb": f"/work/{job_id}.jpg", "created": time.time()}
    threading.Thread(target=_run, args=(job_id,), daemon=True).start()
    return {"id": job_id}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    src = WORK / f"in_{uuid.uuid4().hex[:8]}_{Path(file.filename).name}"
    with open(src, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return _start(src, file.filename, f"upload:{src.name}")


@app.get("/api/samples")
def samples():
    return [p.name for p in sorted(ROOT.glob("*.mp4"))]


@app.get("/api/sample_thumb/{name}")
def sample_thumb(name: str):
    src = ROOT / Path(name).name
    if not src.exists():
        raise HTTPException(404)
    dst = WORK / f"sample_{src.stem}.jpg"
    _thumb(src, dst)
    return FileResponse(dst)


@app.post("/api/sample/{name}")
def sample(name: str):
    src = ROOT / Path(name).name
    if not src.exists() or src.suffix.lower() != ".mp4":
        raise HTTPException(404)
    st = src.stat()
    return _start(src, name, f"sample:{name}:{st.st_size}:{int(st.st_mtime)}")


@app.get("/api/jobs")
def list_jobs():
    return sorted(jobs.values(), key=lambda j: -j["created"])


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(404)
    if j["status"] == "running":
        raise HTTPException(409, "still processing")
    jobs.pop(job_id)
    for ext in (".mp4", ".jpg"):
        (WORK / f"{job_id}{ext}").unlink(missing_ok=True)
    src = sources.pop(job_id, None)
    if src and src.parent == WORK:
        src.unlink(missing_ok=True)
    _save_lib()
    return {"ok": True}



# ------------------------------------------------------------------ point tracking
import numpy as np
from pydantic import BaseModel

_gray_cache: dict[str, list] = {}


def _gray_frames(job_id: str):
    if job_id not in _gray_cache:
        cap = cv2.VideoCapture(str(sources[job_id]))
        frames = []
        while True:
            ok, f = cap.read()
            if not ok:
                break
            h, w = f.shape[:2]
            sc = min(1.0, 640 / max(h, w))
            frames.append(cv2.cvtColor(cv2.resize(f, (int(w * sc), int(h * sc))), cv2.COLOR_BGR2GRAY))
        cap.release()
        _gray_cache[job_id] = frames
    return _gray_cache[job_id]


class TrackReq(BaseModel):
    frame: int
    x: float  # normalised 0..1
    y: float


@app.post("/api/track/{job_id}")
def track(job_id: str, req: TrackReq):
    """Follow a point through the clip with pyramidal Lucas-Kanade (median of a 3x3 patch)."""
    if job_id not in sources:
        raise HTTPException(404)
    g = _gray_frames(job_id)
    n = len(g)
    h, w = g[0].shape
    f0 = max(0, min(n - 1, req.frame))
    grid = np.array([[dx, dy] for dy in (-8, 0, 8) for dx in (-8, 0, 8)], np.float32)
    out = [None] * n
    out[f0] = [float(req.x), float(req.y)]
    lk = dict(winSize=(31, 31), maxLevel=3,
              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))

    def walk(rng):
        cx, cy = req.x * w, req.y * h
        prev = f0
        for i in rng:
            pts = (grid + [cx, cy]).reshape(-1, 1, 2).astype(np.float32)
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(g[prev], g[i], pts, None, **lk)
            ok = st.reshape(-1) == 1
            if ok.sum() >= 3:
                d = np.median((nxt.reshape(-1, 2) - pts.reshape(-1, 2))[ok], axis=0)
                cx, cy = cx + d[0], cy + d[1]
            out[i] = [float(min(max(cx / w, -.2), 1.2)), float(min(max(cy / h, -.2), 1.2))]
            prev = i

    walk(range(f0 + 1, n))
    walk(range(f0 - 1, -1, -1))
    return {"pts": out}


exports: dict[str, dict] = {}


@app.post("/api/export/{job_id}/start")
def export_start(job_id: str, fps: float, w: int, h: int, name: str = "clip"):
    """The browser sends raw transparent RGBA overlay frames (bottom-up, straight alpha); ffmpeg lays them over the ORIGINAL file
    (same resolution, frame rate and audio), so the footage itself is never re-processed."""
    src = sources.get(job_id)
    if not src or not src.exists():
        raise HTTPException(404, "original video not found")
    cap = cv2.VideoCapture(str(src))
    sw, sh = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    eid = uuid.uuid4().hex[:8]
    out = WORK / f"export_{eid}.mp4"
    fc = (f"[1:v]vflip,scale={sw}:{sh}:flags=lanczos,format=rgba[ov];"
          f"[0:v][ov]overlay=0:0:format=auto:eof_action=pass[v]")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
           "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-framerate", str(fps), "-i", "-",
           "-filter_complex", fc, "-map", "[v]", "-map", "0:a?", "-c:a", "copy",
           "-c:v", "libx264", "-crf", "12", "-preset", "medium", "-pix_fmt", "yuv420p",
           "-fps_mode", "passthrough", "-movflags", "+faststart", str(out)]
    exports[eid] = {"proc": subprocess.Popen(cmd, stdin=subprocess.PIPE), "out": out, "name": name}
    return {"id": eid}


@app.post("/api/export/frame/{eid}")
async def export_frame(eid: str, request: Request):
    ex = exports.get(eid)
    if not ex:
        raise HTTPException(404)
    ex["proc"].stdin.write(await request.body())
    return {"ok": True}


@app.post("/api/export/finish/{eid}")
def export_finish(eid: str):
    ex = exports.pop(eid, None)
    if not ex:
        raise HTTPException(404)
    ex["proc"].stdin.close()
    if ex["proc"].wait() != 0:
        raise HTTPException(500, "ffmpeg failed")
    return FileResponse(ex["out"], media_type="video/mp4", filename=f"{ex['name']}_comic.mp4")


app.mount("/work", StaticFiles(directory=WORK), name="work")
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
