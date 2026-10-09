// ComicFX — overlay editor. Footage passes through untouched; effect layers are drawn on top.
// Shaders & effect schemas: layers.js
const $ = s => document.querySelector(s);
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const fmtT = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtEta = s => s < 60 ? `${Math.max(1, Math.round(s))}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function toast(msg, kind = 'ok', ms = 4200) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ================================================================ WebGL
const cv = $('#cv');
const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
if (!gl) toast('WebGL2 is not available in this browser', 'err');

function compileProgram(fsSrc, label) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${label}: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'a');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${label}: ${gl.getProgramInfoLog(p)}`);
  return p;
}

gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const tex = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, tex);
for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
  [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);

const COMMON = ['uVid', 'uRes', 'uPanel', 'uTime', 'uT', 'uStep', 'uP', 'uAlpha', 'uSeed', 'uOccl', 'uCut', 'uPos', 'uP2', 'uDRange'];
const progs = {};
function getProg(type) {
  if (progs[type]) return progs[type];
  let entry;
  try {
    const p = compileProgram(typeSource(type), type);
    const loc = {};
    for (const n of COMMON) loc[n] = gl.getUniformLocation(p, n);
    for (const prm of TYPES[type].params) loc['u_' + prm.id] = gl.getUniformLocation(p, 'u_' + prm.id);
    entry = { p, loc };
  } catch (e) {
    console.error(e); toast(`Effect "${TYPES[type].name}" failed to compile — see console`, 'err', 7000);
    entry = { broken: true };
  }
  return (progs[type] = entry);
}
let base = null;
function getBase() {
  if (!base) {
    const p = compileProgram(BASE_PASS, 'base');
    base = { p, uRes: gl.getUniformLocation(p, 'uRes'), uPanel: gl.getUniformLocation(p, 'uPanel'),
      uMode: gl.getUniformLocation(p, 'uMode'), uVid: gl.getUniformLocation(p, 'uVid') };
  }
  return base;
}

// ================================================================ project (effect layers)
let layers = [], selId = null, nextId = 1;
const video = document.createElement('video');
video.muted = true; video.loop = true; video.playsInline = true;
let info = null, ready = false, recording = false;
let viewMode = 0, cmpOn = false, split = .5, pick = null;
let loadedId = null;

function makeLayer(type, over = {}) {
  const T = TYPES[type], d = T.defaults;
  const L = {
    id: 'L' + (nextId++), type, name: T.name, visible: true,
    start: clamp(video.currentTime || 0, 0, Math.max(0, (video.duration || 5) - .5)),
    dur: d.dur, draw: d.draw, out: d.out, boil: d.boil,
    pos: [.5, .5], p2: [.5, .8], dr: d.dr ? [...d.dr] : [0, 1], occl: !!d.occl, cut: .55,
    follow: !!d.follow, seed: Math.floor(Math.random() * 90) + 1, params: {}, track: null, trackFrame: 0,
  };
  for (const p of T.params) L.params[p.id] = p.val;
  return Object.assign(L, over);
}
const selLayer = () => layers.find(l => l.id === selId);

let saveTimer = 0;
function saveProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!loadedId) return;
    try { localStorage.setItem('comicfx.proj.' + loadedId, JSON.stringify({ layers, nextId })); } catch {}
  }, 250);
}
function loadProject(id) {
  layers = []; selId = null;
  try {
    const d = JSON.parse(localStorage.getItem('comicfx.proj.' + id) || 'null');
    if (d) { layers = d.layers.filter(l => TYPES[l.type]); nextId = d.nextId || layers.length + 1; selId = layers.at(-1)?.id ?? null; }
  } catch {}
}

// where is this layer at time t? (follows the tracked point if enabled)
function layerPos(L, t) {
  if (!L.follow || !L.track || !info) return { pos: L.pos, p2: L.p2 };
  const f = clamp(t * info.fps, 0, L.track.length - 1), i0 = Math.floor(f), i1 = Math.min(L.track.length - 1, i0 + 1), fr = f - i0;
  const a = L.track[i0], b = L.track[i1], r = L.track[L.trackFrame] || a;
  const dx = a[0] + (b[0] - a[0]) * fr - r[0], dy = a[1] + (b[1] - a[1]) * fr - r[1];
  return { pos: [L.pos[0] + dx, L.pos[1] + dy], p2: [L.p2[0] + dx, L.p2[1] + dy] };
}
function layerEnv(L, t) {
  const tl = t - L.start;
  if (!L.visible || tl < 0 || tl > L.dur) return null;
  const P = L.draw > 0 ? Math.min(1, tl / L.draw) : 1;
  const alpha = L.out > 0 ? clamp((L.dur - tl) / L.out, 0, 1) : 1;
  const step = Math.floor(t * L.boil + 1e-6);
  return { P, alpha, step, tstep: step / L.boil };
}

// ================================================================ rendering
function drawLayer(L, t) {
  const env = layerEnv(L, t); if (!env) return;
  const pr = getProg(L.type); if (pr.broken) return;
  gl.useProgram(pr.p);
  const u = pr.loc, { pos, p2 } = layerPos(L, t);
  gl.uniform1i(u.uVid, 0);
  gl.uniform2f(u.uRes, cv.width, cv.height);
  gl.uniform2f(u.uPanel, info.width, info.height);
  gl.uniform1f(u.uTime, t); gl.uniform1f(u.uT, env.tstep); gl.uniform1f(u.uStep, env.step);
  gl.uniform1f(u.uP, env.P); gl.uniform1f(u.uAlpha, env.alpha); gl.uniform1f(u.uSeed, L.seed);
  gl.uniform1f(u.uOccl, L.occl ? 1 : 0); gl.uniform1f(u.uCut, L.cut);
  gl.uniform2f(u.uPos, pos[0], pos[1]); gl.uniform2f(u.uP2, p2[0], p2[1]);
  gl.uniform2f(u.uDRange, L.dr[0], L.dr[1]);
  for (const prm of TYPES[L.type].params) {
    const loc = u['u_' + prm.id], v = L.params[prm.id];
    if (prm.type === 'color') gl.uniform3fv(loc, hexToRgb(v)); else gl.uniform1f(loc, +v);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// mode: 'view' (preview with the footage underneath) | 'export' (transparent overlay only)
function render(mode = 'view') {
  gl.viewport(0, 0, cv.width, cv.height);
  gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  const t = video.currentTime;
  const vm = mode === 'export' ? 1 : viewMode;
  if (mode === 'export') { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  else if (vm === 1) { gl.clearColor(.06, .06, .09, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  else {
    const b = getBase(); gl.useProgram(b.p);
    gl.uniform1i(b.uVid, 0); gl.uniform2f(b.uRes, cv.width, cv.height); gl.uniform2f(b.uPanel, info.width, info.height);
    gl.uniform1f(b.uMode, vm === 0 ? 0 : vm === 2 ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  if (vm > 1) return;                                // depth / flow debug views have no effects
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  if (cmpOn && mode === 'view' && vm === 0) {         // left of the divider stays original
    const x = Math.round(split * cv.width);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x, 0, cv.width - x, cv.height);
  }
  for (const L of layers) drawLayer(L, t);
  gl.disable(gl.SCISSOR_TEST);
}

function sizeCanvas() {
  if (!info) return;
  const st = $('#canvasWrap'), cs = getComputedStyle(st);
  const aw = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const sc = Math.min(aw / info.width, ah / info.height, 2);
  cv.style.width = info.width * sc + 'px'; cv.style.height = info.height * sc + 'px';
  if (cv.width !== info.width) { cv.width = info.width; cv.height = info.height; }
}
window.addEventListener('resize', sizeCanvas);

function upload() {
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
}
function onVideoFrame() { upload(); video.requestVideoFrameCallback(onVideoFrame); }
video.addEventListener('seeked', () => ready && upload());

let scrubbing = false;
function loop() {
  requestAnimationFrame(loop);
  if (!ready) return;
  render();
  const d = video.duration || 1;
  if (!scrubbing) { $('#scrub').value = video.currentTime / d * 1000; slidePct($('#scrub')); }
  $('#time').textContent = `${fmtT(video.currentTime)} / ${fmtT(d)}`;
  updatePlayhead();
}

// ================================================================ tiny UI helpers
function slidePct(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); }

function addSlider(parent, spec, obj, key, onChange, getRange) {
  const r = document.createElement('div'); r.className = 'row';
  const [min, max] = getRange ? getRange() : [spec.min, spec.max];
  r.innerHTML = `<label>${spec.label}</label><output></output><input type="range" min="${min}" max="${max}" step="${spec.step}">`;
  const el = r.querySelector('input'), out = r.querySelector('output');
  el.value = obj[key]; out.textContent = +(+obj[key]).toFixed(3); slidePct(el);
  el.oninput = () => { obj[key] = +el.value; out.textContent = +(+el.value).toFixed(3); slidePct(el); onChange && onChange(); saveProject(); };
  parent.appendChild(r); return el;
}
function addColor(parent, spec, obj, key) {
  const r = document.createElement('div'); r.className = 'row inline';
  r.innerHTML = `<label>${spec.label}</label><input type="color" value="${obj[key]}">`;
  r.querySelector('input').oninput = e => { obj[key] = e.target.value; saveProject(); };
  parent.appendChild(r);
}
function addSelect(parent, spec, obj, key) {
  const r = document.createElement('div'); r.className = 'row inline';
  r.innerHTML = `<label>${spec.label}</label><select>${spec.opts.map((o, i) => `<option value="${i}">${o}</option>`).join('')}</select>`;
  const el = r.querySelector('select'); el.value = obj[key];
  el.oninput = () => { obj[key] = +el.value; saveProject(); };
  parent.appendChild(r);
}
function addSwitch(parent, label, obj, key, onChange) {
  const r = document.createElement('div'); r.className = 'row inline';
  r.innerHTML = `<label>${label}</label><label class="sw"><input type="checkbox" ${obj[key] ? 'checked' : ''}><span></span></label>`;
  r.querySelector('input').oninput = e => { obj[key] = e.target.checked; onChange && onChange(); saveProject(); };
  parent.appendChild(r);
}
function section(parent, title) {
  const h = document.createElement('div'); h.className = 'insp-sec'; h.textContent = title; parent.appendChild(h);
}

// ================================================================ effects panel
const addMenu = $('#addMenu');
for (const [key, T] of Object.entries(TYPES)) {
  const b = document.createElement('button'); b.className = 'add-item';
  b.innerHTML = `<span class="ic" style="background:${T.color}"><svg viewBox="0 0 24 24">${T.icon}</svg></span><div><b>${T.name}</b><span>${T.desc}</span></div>`;
  b.onclick = () => { addLayer(key); addMenu.hidden = true; };
  addMenu.appendChild(b);
}
$('#addBtn').onclick = () => {
  if (!ready) return toast('Open a clip first', 'err');
  addMenu.hidden = !addMenu.hidden;
};

function addLayer(type) {
  const L = makeLayer(type);
  if (TYPES[type].defaults.needsP2) { L.pos = [.5, .15]; L.p2 = [.5, .78]; }
  layers.push(L); selId = L.id;
  refreshPanels(); saveProject();
  startPick('pos');
}

function refreshPanels() { renderLayerList(); renderInspector(); renderTimeline(); }

function renderLayerList() {
  const list = $('#layerList'); list.innerHTML = '';
  $('#layerEmpty').hidden = layers.length > 0;
  [...layers].reverse().forEach(L => {
    const T = TYPES[L.type], n = layers.filter(x => x.type === L.type).indexOf(L) + 1;
    const row = document.createElement('div');
    row.className = 'layer' + (L.id === selId ? ' sel' : '') + (L.visible ? '' : ' off');
    row.innerHTML = `<span class="dotc" style="background:${T.color}"></span><span class="nm">${T.name} ${n}</span>
      <button class="tiny" data-a="vis" title="Show / hide">${L.visible ? '◉' : '○'}</button>
      <button class="tiny" data-a="dup" title="Duplicate">⧉</button>
      <button class="tiny" data-a="del" title="Delete">×</button>`;
    row.onclick = e => {
      const a = e.target.dataset.a;
      if (a === 'vis') L.visible = !L.visible;
      else if (a === 'dup') { const c = JSON.parse(JSON.stringify(L)); c.id = 'L' + (nextId++); c.seed += 7; c.start = Math.min(L.start + .3, (video.duration || 5) - .3); layers.push(c); selId = c.id; }
      else if (a === 'del') { layers = layers.filter(x => x !== L); if (selId === L.id) selId = layers.at(-1)?.id ?? null; }
      else selId = L.id;
      refreshPanels(); saveProject();
    };
    list.appendChild(row);
  });
}

function renderInspector() {
  const box = $('#layerInspector'); box.innerHTML = '';
  const L = selLayer(); if (!L) return;
  const T = TYPES[L.type], dur = video.duration || 10;
  const mk = (html, fn) => { const b = document.createElement('button'); b.className = 'pill'; b.innerHTML = html; b.onclick = fn; return b; };

  section(box, 'Placement');
  const row = document.createElement('div'); row.className = 'btn-row';
  row.appendChild(mk('Place on video', () => startPick('pos')));
  if (T.defaults.needsP2) row.appendChild(mk('Set end point', () => startPick('p2')));
  row.appendChild(mk('Reroll look', () => { L.seed = Math.floor(Math.random() * 900) + 1; saveProject(); }));
  box.appendChild(row);
  addSwitch(box, 'Follow footage' + (L.follow && L.track ? ' · tracked' : ''), L, 'follow', async () => {
    if (L.follow && !L.track) await trackLayer(L, L.pos[0], L.pos[1]);
    renderInspector();
  });

  section(box, 'Timing');
  addSlider(box, { label: 'Start', step: .05 }, L, 'start', renderTimeline, () => [0, dur]);
  addSlider(box, { label: 'Length', step: .05 }, L, 'dur', renderTimeline, () => [.2, Math.max(dur, 2)]);
  addSlider(box, { label: 'Draw-on time', step: .05 }, L, 'draw', renderTimeline, () => [0, Math.max(L.dur, .5)]);
  addSlider(box, { label: 'Fade-out', step: .05 }, L, 'out', null, () => [0, 2]);
  addSlider(box, { label: 'Hand-drawn fps', step: 1 }, L, 'boil', null, () => [4, 30]);

  section(box, 'Depth');
  addSwitch(box, 'Hide behind subject', L, 'occl', renderInspector);
  if (L.occl) addSlider(box, { label: 'Subject depth', step: .01 }, L, 'cut', null, () => [0, 1]);
  if (L.type === 'contour') {
    addSlider(box, { label: 'Trace from depth', step: .01 }, L.dr, 0, null, () => [0, 1]);
    addSlider(box, { label: 'Trace up to', step: .01 }, L.dr, 1, null, () => [0, 1]);
  }
  const dr = document.createElement('div'); dr.className = 'btn-row';
  dr.appendChild(mk('Pick subject from video', () => startPick('subject')));
  box.appendChild(dr);

  section(box, T.name);
  for (const p of T.params) {
    if (p.type === 'color') addColor(box, p, L.params, p.id);
    else if (p.type === 'select') addSelect(box, p, L.params, p.id);
    else addSlider(box, p, L.params, p.id);
  }
}

// ================================================================ timeline
function renderTimeline() {
  const rows = $('#tlRows'); rows.innerHTML = '';
  $('#timeline').hidden = !ready;
  const dur = video.duration || 1;
  rows.style.position = 'relative';
  [...layers].reverse().forEach(L => {
    const T = TYPES[L.type];
    const row = document.createElement('div'); row.className = 'tl-row' + (L.id === selId ? ' sel' : '');
    row.innerHTML = `<div class="lb">${T.name}</div><div class="tl-track"><div class="tl-bar ${L.visible ? '' : 'hid'}" style="background:${T.color}">
      <div class="tl-draw"></div><i class="l"></i><i class="r"></i></div></div>`;
    const track = row.querySelector('.tl-track'), bar = row.querySelector('.tl-bar'), dw = row.querySelector('.tl-draw');
    const place = () => {
      bar.style.left = L.start / dur * 100 + '%'; bar.style.width = L.dur / dur * 100 + '%';
      dw.style.width = (L.dur > 0 ? Math.min(1, L.draw / L.dur) : 0) * 100 + '%';
    };
    place();
    row.onpointerdown = e => {
      if (selId !== L.id) { selId = L.id; renderLayerList(); renderInspector(); rows.querySelectorAll('.tl-row').forEach(r => r.classList.remove('sel')); row.classList.add('sel'); }
      const rect = track.getBoundingClientRect();
      if (!e.target.closest('.tl-bar')) { video.currentTime = clamp((e.clientX - rect.left) / rect.width, 0, 1) * dur; return; }
      const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'm';
      const x0 = e.clientX, s0 = L.start, d0 = L.dur;
      bar.setPointerCapture(e.pointerId); bar.style.cursor = 'grabbing';
      const move = ev => {
        const dt = (ev.clientX - x0) / rect.width * dur;
        if (mode === 'm') L.start = clamp(s0 + dt, 0, dur - .1);
        else if (mode === 'r') L.dur = clamp(d0 + dt, .2, dur * 2);
        else { const ns = clamp(s0 + dt, 0, s0 + d0 - .2); L.dur = d0 - (ns - s0); L.start = ns; }
        L.draw = Math.min(L.draw, L.dur);
        place();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', () => { bar.removeEventListener('pointermove', move); bar.style.cursor = ''; renderInspector(); saveProject(); }, { once: true });
    };
    rows.appendChild(row);
  });
  const ph = document.createElement('div'); ph.className = 'tl-play'; ph.id = 'playhead'; rows.appendChild(ph);
}
function updatePlayhead() {
  const ph = $('#playhead'); if (!ph) return;
  const rows = $('#tlRows'), tr = rows.querySelector('.tl-track'); if (!tr) { ph.style.display = 'none'; return; }
  ph.style.display = '';
  const r = rows.getBoundingClientRect(), t = tr.getBoundingClientRect();
  ph.style.left = (t.left - r.left + (video.currentTime / (video.duration || 1)) * t.width) + 'px';
  ph.style.top = (t.top - r.top - 4) + 'px';
  ph.style.height = (rows.querySelectorAll('.tl-row').length * 30 + 4) + 'px';
}

// ================================================================ picking + tracking
function startPick(kind) {
  const L = selLayer(); if (!L || !ready) return;
  pick = { kind, id: L.id };
  const txt = { pos: 'Click the video to place this effect', p2: 'Click the video to set the end point',
    subject: 'Click the subject to read its depth' }[kind];
  $('#pickText').textContent = txt; $('#pickBanner').hidden = false; cv.classList.add('picking');
}
function endPick() { pick = null; $('#pickBanner').hidden = true; cv.classList.remove('picking'); }
$('#pickCancel').onclick = endPick;

const dctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
function sampleDepth(x, y) {
  dctx.canvas.width = dctx.canvas.height = 1;
  const sx = info.width + clamp(x, 0, .999) * info.width, sy = clamp(y, 0, .999) * info.height;  // depth panel = top-right
  dctx.drawImage(video, sx, sy, 1, 1, 0, 0, 1, 1);
  return dctx.getImageData(0, 0, 1, 1).data[0] / 255;
}

async function trackLayer(L, x, y) {
  if (!loadedId) return;
  const frame = Math.round(video.currentTime * info.fps);
  toast('Tracking that point through the clip…', 'ok', 2000);
  try {
    const r = await fetch(`/api/track/${loadedId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frame, x, y }) });
    if (!r.ok) throw new Error(r.status);
    const { pts } = await r.json();
    L.track = pts; L.trackFrame = frame; L.pos = [x, y];
    saveProject(); toast('Tracked — the effect now follows the footage');
  } catch (e) { toast('Tracking failed', 'err'); }
}

cv.addEventListener('click', async e => {
  const L = selLayer(); if (!L || !ready) return;
  const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  const kind = pick ? pick.kind : (e.altKey && TYPES[L.type].defaults.needsP2 ? 'p2' : 'pos');
  endPick();
  const f = $('#focus'); f.hidden = false; f.style.left = x * 100 + '%'; f.style.top = y * 100 + '%';
  f.style.animation = 'none'; void f.offsetWidth; f.style.animation = ''; setTimeout(() => (f.hidden = true), 700);
  if (kind === 'subject') {
    const d = sampleDepth(x, y);
    if (L.type === 'contour') L.dr = [Math.max(0, d - .2), 1]; else { L.occl = true; L.cut = Math.max(0, d - .07); }
    toast(`Subject depth ${d.toFixed(2)} set`);
  } else if (kind === 'p2') {
    const cur = layerPos(L, video.currentTime).p2;
    L.p2 = [x - (cur[0] - L.p2[0]), y - (cur[1] - L.p2[1])];
  } else {
    const rel = [L.p2[0] - L.pos[0], L.p2[1] - L.pos[1]];
    L.pos = [x, y]; L.p2 = [x + rel[0], y + rel[1]];
    if (L.follow) await trackLayer(L, x, y);
  }
  saveProject(); renderInspector();
});

// ================================================================ dock
const ICO_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
const ICO_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
$('#play').innerHTML = ICO_PAUSE;
video.addEventListener('play', () => ($('#play').innerHTML = ICO_PAUSE));
video.addEventListener('pause', () => ($('#play').innerHTML = ICO_PLAY));
const togglePlay = () => (video.paused ? video.play() : video.pause());
$('#play').onclick = togglePlay;
$('#scrub').addEventListener('input', e => { scrubbing = true; video.currentTime = e.target.value / 1000 * video.duration; slidePct(e.target); });
$('#scrub').addEventListener('change', () => (scrubbing = false));

function setView(v) { viewMode = v; document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', +b.dataset.v === v)); }
$('#views').onclick = e => e.target.dataset.v !== undefined && setView(+e.target.dataset.v);

function setCompare(on) { cmpOn = on; $('#cmp').classList.toggle('on', on); $('#split').hidden = !on; $('#split').style.left = split * 100 + '%'; }
$('#cmp').onclick = () => setCompare(!cmpOn);
$('#split').addEventListener('pointerdown', e => {
  const el = $('#split'); el.setPointerCapture(e.pointerId);
  const move = ev => { const r = cv.getBoundingClientRect(); split = clamp((ev.clientX - r.left) / r.width, 0, 1); el.style.left = split * 100 + '%'; };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
});

document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); ready && togglePlay(); }
  else if (e.key === 'c' && ready) setCompare(!cmpOn);
  else if (e.key === 'Escape') endPick();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selLayer()) { layers = layers.filter(x => x.id !== selId); selId = layers.at(-1)?.id ?? null; refreshPanels(); saveProject(); }
  else if (e.key === 'ArrowRight' && ready) { video.pause(); video.currentTime += 1 / info.fps; }
  else if (e.key === 'ArrowLeft' && ready) { video.pause(); video.currentTime -= 1 / info.fps; }
});

// ================================================================ library / jobs
let jobs = [], selectedId = null;
const jobEls = new Map();
const STAGE_TXT = { loading: 'Loading depth model', depth: 'Estimating depth', motion: 'Tracking motion & packing' };

function jobMeta(j, anyRunning) {
  if (j.status === 'error') return ['err', 'Failed', j.error || 'Something went wrong'];
  if (j.status === 'done') return ['ok', 'Ready', `${j.info.width}×${j.info.height} · ${j.info.frames} frames`];
  if (j.status === 'queued') return ['wait', 'Queued', anyRunning ? 'Waiting for the GPU — another clip is processing' : 'Starting…'];
  const el = Date.now() / 1000 - j.started;
  const eta = j.progress > .04 ? ` · ~${fmtEta(el * (1 - j.progress) / j.progress)} left` : '';
  return ['run', Math.round(j.progress * 100) + '%', `${STAGE_TXT[j.stage] || 'Working'}${eta}`];
}

function renderJobs() {
  const anyRunning = jobs.some(j => j.status === 'running');
  $('#jobsEmpty').hidden = jobs.length > 0;
  $('#gpuText').textContent = anyRunning ? 'GPU working' : 'GPU idle';
  $('#gpu').classList.toggle('busy', anyRunning);
  const seen = new Set();
  jobs.forEach((j, idx) => {
    seen.add(j.id);
    let el = jobEls.get(j.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'job';
      el.innerHTML = `<div class="th"><span class="badge"></span><button class="x" title="Remove">×</button></div>
        <div class="bd"><div class="nm"></div><div class="mt"></div><div class="bar"><i></i></div></div>`;
      el.onclick = () => selectJob(j.id);
      el.querySelector('.x').onclick = async ev => {
        ev.stopPropagation();
        const r = await fetch('/api/jobs/' + j.id, { method: 'DELETE' });
        if (!r.ok) return toast("Can't remove a clip that is still processing", 'err');
        if (selectedId === j.id) { selectedId = null; unloadVideo(); }
        refresh();
      };
      el.querySelector('.th').style.backgroundImage = `url(${j.thumb})`;
      el.querySelector('.nm').textContent = j.name;
      jobEls.set(j.id, el);
    }
    const [kind, badge, meta] = jobMeta(j, anyRunning);
    el.classList.toggle('sel', j.id === selectedId);
    el.classList.toggle('busy', j.status !== 'done');
    el.classList.toggle('err', kind === 'err');
    const b = el.querySelector('.badge'); b.className = 'badge ' + kind; b.textContent = badge;
    el.querySelector('.mt').textContent = meta;
    el.querySelector('.bar').hidden = j.status === 'done';
    el.querySelector('.bar i').style.width = Math.round(j.progress * 100) + '%';
    const list = $('#jobs');
    if (list.children[idx] !== el) list.insertBefore(el, list.children[idx] || null);
  });
  for (const [id, el] of jobEls) if (!seen.has(id)) { el.remove(); jobEls.delete(id); }
  updateOverlay(anyRunning);
}

function updateOverlay(anyRunning) {
  const j = jobs.find(x => x.id === selectedId);
  const show = j && j.status !== 'done';
  $('#overlay').hidden = !show;
  if (!show) return;
  const [, , meta] = jobMeta(j, anyRunning);
  const p = j.status === 'error' ? 0 : j.progress;
  $('#ringFg').style.strokeDashoffset = 327 * (1 - p);
  $('#ringNum').textContent = j.status === 'error' ? '!' : Math.round(p * 100) + '%';
  $('#ovTitle').textContent = j.status === 'error' ? 'Processing failed' : j.status === 'queued' ? 'Waiting in queue' : STAGE_TXT[j.stage] || 'Working';
  $('#ovSub').textContent = `${j.name} — ${meta}`;
  $('.ov-card').classList.toggle('err', j.status === 'error');
  const order = ['queued', 'depth', 'motion', 'done'];
  const cur = order.indexOf(j.status === 'queued' ? 'queued' : j.stage === 'loading' ? 'depth' : j.stage);
  $('#steps').querySelectorAll('li').forEach((li, i) => { li.className = i < cur ? 'past' : i === cur ? 'cur' : ''; });
}

function unloadVideo() {
  ready = false; video.pause(); video.removeAttribute('src'); loadedId = null; layers = []; selId = null;
  $('#viewport').hidden = true; $('#dock').hidden = true; $('#timeline').hidden = true; $('#export').disabled = true;
  $('#crumb').textContent = 'No clip loaded'; refreshPanels();
  $('#empty').hidden = jobs.length > 0 && selectedId !== null;
}

async function selectJob(id) {
  selectedId = id; renderJobs();
  const j = jobs.find(x => x.id === id);
  if (j && j.status === 'done') await loadJob(j);
  else { ready = false; video.pause(); }
  $('#empty').hidden = true;
}

async function loadJob(j) {
  if (loadedId === j.id) { ready = true; return; }
  ready = false; loadedId = j.id; info = j.info; endPick();
  video.src = j.url;
  await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = rej; });
  if (loadedId !== j.id) return;
  cv.width = 0; $('#viewport').hidden = false; $('#dock').hidden = false;
  sizeCanvas(); upload(); ready = true;
  loadProject(j.id);
  $('#export').disabled = false;
  $('#crumb').textContent = `${j.name} · ${j.info.width}×${j.info.height} · ${j.info.frames} frames`;
  video.requestVideoFrameCallback(onVideoFrame);
  refreshPanels();
  video.play();
}

async function refresh() {
  try {
    const prev = new Map(jobs.map(j => [j.id, j.status]));
    jobs = await (await fetch('/api/jobs')).json();
    for (const j of jobs) {
      const was = prev.get(j.id);
      if (was && was !== 'done' && j.status === 'done') toast(`${j.name} is ready`);
      if (was && was !== 'error' && j.status === 'error') toast(`${j.name} failed`, 'err');
    }
    renderJobs();
    const sel = jobs.find(j => j.id === selectedId);
    if (sel && sel.status === 'done' && loadedId !== sel.id) loadJob(sel);
  } catch { /* server restarting */ }
}
setInterval(refresh, 800);

async function addFile(f) {
  const fd = new FormData(); fd.append('file', f);
  $('#empty').hidden = true;
  const { id } = await (await fetch('/api/upload', { method: 'POST', body: fd })).json();
  await refresh(); selectJob(id);
}
for (const id of ['#file', '#file2']) $(id).onchange = e => { if (e.target.files[0]) addFile(e.target.files[0]); e.target.value = ''; };
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = [...e.dataTransfer.files].find(f => f.type.startsWith('video/'));
  if (f) addFile(f); else toast('Drop a video file', 'err');
});
fetch('/api/samples').then(r => r.json()).then(list => {
  for (const n of list) {
    const d = document.createElement('div'); d.className = 'sample';
    d.innerHTML = `<div class="th" style="background-image:url(/api/sample_thumb/${n})"></div><span>${n}</span>`;
    d.onclick = async () => {
      $('#empty').hidden = true;
      const { id } = await (await fetch('/api/sample/' + n, { method: 'POST' })).json();
      await refresh(); selectJob(id);
    };
    $('#samples').appendChild(d);
  }
});

// ================================================================ export
// Overlay-only transparent RGBA frame per source frame -> server lays them over the ORIGINAL file with ffmpeg.
const seekTo = t => new Promise(res => { video.addEventListener('seeked', res, { once: true }); video.currentTime = t; });
// Raw RGBA readback (PNG encoding in the browser was ~1 s/frame). The canvas holds premultiplied
// alpha, so convert to straight alpha here; rows come bottom-up and the server flips them.
let pixBuf = null;
function readOverlay() {
  const w = cv.width, h = cv.height;
  if (!pixBuf || pixBuf.length !== w * h * 4) pixBuf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixBuf);
  for (let i = 0; i < pixBuf.length; i += 4) {
    const a = pixBuf[i + 3];
    if (a > 0 && a < 255) {
      const k = 255 / a;
      pixBuf[i] = Math.min(255, pixBuf[i] * k); pixBuf[i + 1] = Math.min(255, pixBuf[i + 1] * k); pixBuf[i + 2] = Math.min(255, pixBuf[i + 2] * k);
    }
  }
  return pixBuf;
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', body });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r;
}

$('#export').onclick = async () => {
  if (recording || !ready) return;
  if (!layers.some(l => l.visible)) return toast('Add at least one effect first', 'err');
  const job = jobs.find(j => j.id === loadedId), name = job.name.replace(/\.[^.]+$/, '');
  recording = true; $('#export').disabled = true; endPick();
  const wasPlaying = !video.paused, resume = video.currentTime;
  video.pause();
  const label = t => ($('#exportLabel').textContent = t);
  try {
    const n = info.frames, fps = info.fps;
    const { id } = await (await post(`/api/export/${job.id}/start?fps=${fps}&w=${cv.width}&h=${cv.height}&name=${encodeURIComponent(name)}`)).json();
    for (let i = 0; i < n; i++) {
      await seekTo((i + .5) / fps); upload();
      render('export');
      await post('/api/export/frame/' + id, readOverlay());
      $('#exportFill').style.width = (i + 1) / n * 100 + '%';
      label(`Rendering ${Math.round((i + 1) / n * 100)}%`);
    }
    label('Compositing…');
    const blob = await (await post('/api/export/finish/' + id)).blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}_comic.mp4`; a.click();
    toast(`Exported ${name}_comic.mp4 — original footage untouched`);
  } catch (err) { console.error(err); toast('Export failed: ' + err.message, 'err', 7000); }
  recording = false; video.currentTime = resume; if (wasPlaying) video.play();
  $('#export').disabled = false; $('#exportFill').style.width = '0'; label('Export MP4');
};

// ================================================================ boot
refreshPanels();
requestAnimationFrame(loop);
refresh();
