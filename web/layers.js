// Overlay effect types. Each one is a fragment shader `vec4 fx(vec2 uv, vec2 A)` that returns
// PREMULTIPLIED RGBA, drawn on top of the untouched footage.  uv: 0..1, y-down.  A: aspect (w/h, 1).
// Shared uniforms: uPos/uP2 anchors, uP draw-on progress 0..1, uStep boil step index, uT stepped time,
// uSeed, uDRange (depth band where the effect may appear).

const HEADER = decl => `#version 300 es
precision highp float;
uniform sampler2D uVid;
uniform vec2 uRes, uPanel;
uniform float uTime, uT, uStep, uP, uAlpha, uSeed, uOccl, uCut;
uniform vec2 uPos, uP2, uDRange;
${decl}
out vec4 outc;

float h11(float p){ p=fract(p*.1031); p*=p+33.33; p*=p+p; return fract(p); }
float h21(vec2 p){ vec3 q=fract(vec3(p.xyx)*.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*vn(p); p*=2.03; a*=.5; } return s; }
float lin1(float x){ float i=floor(x); return mix(h11(i),h11(i+1.),fract(x)); }
float ease(float x){ x=clamp(x,0.,1.); return 1.-pow(1.-x,3.); }
float back(float x){ x=clamp(x,0.,1.); float c1=2.2,c3=c1+1.; return 1.+c3*pow(x-1.,3.)+c1*pow(x-1.,2.); }
mat2 rot(float a){ float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }
vec4 over(vec4 top, vec4 bot){ return top + bot*(1.-top.a); }

vec2 pan(vec2 uv, vec2 off){ vec2 e=.5/uPanel; uv=clamp(uv,e,1.-e); return uv*.5+off; }
vec3  C(vec2 uv){ return texture(uVid,pan(uv,vec2(0.,0.))).rgb; }
float D(vec2 uv){ return texture(uVid,pan(uv,vec2(.5,0.))).r; }
float LM(vec2 q){ return dot(C(q),vec3(.299,.587,.114)); }
float sobL(vec2 u, vec2 o){
  float tl=LM(u+vec2(-o.x,-o.y)),t=LM(u+vec2(0,-o.y)),tr=LM(u+vec2(o.x,-o.y));
  float l=LM(u+vec2(-o.x,0)),r=LM(u+vec2(o.x,0));
  float bl=LM(u+vec2(-o.x,o.y)),b=LM(u+vec2(0,o.y)),br=LM(u+o);
  return length(vec2(-tl-2.*l-bl+tr+2.*r+br, -tl-2.*t-tr+bl+2.*b+br));
}
float sobD(vec2 u, vec2 o){
  float tl=D(u+vec2(-o.x,-o.y)),t=D(u+vec2(0,-o.y)),tr=D(u+vec2(o.x,-o.y));
  float l=D(u+vec2(-o.x,0)),r=D(u+vec2(o.x,0));
  float bl=D(u+vec2(-o.x,o.y)),b=D(u+vec2(0,o.y)),br=D(u+o);
  return length(vec2(-tl-2.*l-bl+tr+2.*r+br, -tl-2.*t-tr+bl+2.*b+br));
}
`;

const MAIN = `
void main(){
  vec2 uv = gl_FragCoord.xy/uRes; uv.y = 1.-uv.y;
  vec2 A = vec2(uRes.x/uRes.y, 1.);
  vec4 c = fx(uv, A);
  float occ = uOccl>.5 ? 1.-smoothstep(uCut-.04, uCut+.04, D(uv)) : 1.;   // hide behind the subject
  outc = c*occ*uAlpha;
}`;

const BASE_PASS = `#version 300 es
precision highp float;
uniform sampler2D uVid; uniform vec2 uRes, uPanel; uniform float uMode;
out vec4 outc;
vec2 pan(vec2 uv, vec2 off){ vec2 e=.5/uPanel; uv=clamp(uv,e,1.-e); return uv*.5+off; }
void main(){
  vec2 uv = gl_FragCoord.xy/uRes; uv.y = 1.-uv.y;
  if(uMode<.5){ outc=vec4(texture(uVid,pan(uv,vec2(0.,0.))).rgb,1.); }
  else if(uMode<1.5){ outc=vec4(vec3(texture(uVid,pan(uv,vec2(.5,0.))).r),1.); }
  else { float x=texture(uVid,pan(uv,vec2(0.,.5))).r, y=texture(uVid,pan(uv,vec2(.5,.5))).r;
         vec2 f=(vec2(x,y)*255.-128.)/127.; outc=vec4(.5+f*.5,.5,1.); }
}`;
const VS = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }`;

// ------------------------------------------------------------------ effect types
const TYPES = {

  contour: {
    name: 'Contour strokes', color: '#ffffff',
    desc: 'Hand-drawn outlines that trace the subject and draw themselves on',
    icon: '<path d="M4 20c2-6 3-9 6-11s6-1 8-5"/><path d="M6 21c3-3 5-4 9-4"/>',
    defaults: { dur: 3, draw: 1.2, out: .4, boil: 12, dr: [.45, 1] },
    params: [
      { id: 'color', type: 'color', label: 'Line colour', val: '#ffffff' },
      { id: 'color2', type: 'color', label: 'Accent colour', val: '#ffd23f' },
      { id: 'accent', label: 'Accent offset', min: 0, max: 12, step: .5, val: 3 },
      { id: 'width', label: 'Line width', min: .5, max: 6, step: .1, val: 1.5 },
      { id: 'thr', label: 'Sensitivity', min: .05, max: 1, step: .01, val: .32 },
      { id: 'depthW', label: 'Silhouette edges', min: 0, max: 3, step: .05, val: 1.2 },
      { id: 'colorW', label: 'Detail edges', min: 0, max: 3, step: .05, val: 1 },
      { id: 'brk', label: 'Broken strokes', min: 0, max: 1, step: .02, val: .3 },
      { id: 'brkScale', label: 'Stroke length', min: 1, max: 40, step: 1, val: 9 },
      { id: 'jitter', label: 'Hand wobble', min: 0, max: 5, step: .1, val: 1.4 },
      { id: 'reveal', type: 'select', label: 'Draw-on', opts: ['Sweep', 'Radial from anchor', 'Scribble'], val: 0 },
      { id: 'angle', label: 'Sweep angle', min: 0, max: 360, step: 1, val: 20 },
      { id: 'glow', label: 'Glow', min: 0, max: 1, step: .05, val: .25 },
    ],
    glsl: `
vec4 fx(vec2 uv, vec2 A){
  vec2 px = 1./uRes;
  vec2 j = (vec2(vn(uv*A*7.+uStep*3.1), vn(uv*A*7.+31.+uStep*3.1))-.5)*u_jitter*px*3.;
  vec2 q = uv + j;
  vec2 o = u_width*px;
  float e  = max(sobD(q,o)*u_depthW*4., sobL(q,o)*u_colorW);
  float ln = smoothstep(u_thr, u_thr+.12, e);
  vec2 qa = q - u_accent*px*vec2(1.,-1.);
  float ea = max(sobD(qa,o)*u_depthW*4., sobL(qa,o)*u_colorW);
  float la = smoothstep(u_thr, u_thr+.12, ea);
  float eg = sobD(q,o*4.)*u_depthW*3.;
  float glw = smoothstep(u_thr*.5, u_thr+.5, eg)*u_glow;
  // only inside the chosen depth band
  float dq = D(q);
  float rm = smoothstep(uDRange.x-.08,uDRange.x,dq)*(1.-smoothstep(uDRange.y,uDRange.y+.08,dq));
  // broken pen strokes
  float n = fbm(uv*A*u_brkScale + vec2(uSeed, uStep*.9));
  float keep = u_brk<.01 ? 1. : smoothstep(u_brk*.7, u_brk*.7+.15, n);
  // draw-on reveal
  float s;
  if(u_reveal<.5){
    float a=radians(u_angle); vec2 dir=vec2(cos(a),sin(a));
    float p0=dot(vec2(0.,0.),dir), p1=dot(vec2(A.x,0.),dir), p2=dot(vec2(0.,1.),dir), p3=dot(vec2(A.x,1.),dir);
    float mn=min(min(p0,p1),min(p2,p3)), mx=max(max(p0,p1),max(p2,p3));
    s=(dot(uv*A,dir)-mn)/max(mx-mn,1e-4);
  } else if(u_reveal<1.5){
    vec2 cp=max(uPos*A, vec2(A.x,1.)-uPos*A);
    s=length((uv-uPos)*A)/length(cp);
  } else {
    s=clamp((fbm(uv*A*3.+uSeed)-.15)/.7,0.,1.);
  }
  float rev = smoothstep(s, s+.12, ease(uP)*1.12);
  float aM = ln*keep*rm*rev;
  float aA = la*keep*rm*rev;
  float aG = glw*rm*rev*.6;
  vec4 m = vec4(u_color*aM, aM);
  vec4 ac = vec4(u_color2*aA*.95, aA*.95);
  vec4 g = vec4(u_color2*aG, aG);
  return over(m, over(ac, g));
}`,
  },

  burst: {
    name: 'Impact starburst', color: '#ff4b3a',
    desc: 'Pop-art burst that slams in with halftone shading',
    icon: '<path d="M12 2l2 6 6-3-3 6 6 2-6 2 3 6-6-3-2 6-2-6-6 3 3-6-6-2 6-2-3-6 6 3z"/>',
    defaults: { dur: 1.2, draw: .25, out: .25, boil: 12, follow: true },
    params: [
      { id: 'size', label: 'Size', min: 2, max: 40, step: .5, val: 12 },
      { id: 'spikes', label: 'Spikes', min: 5, max: 24, step: 1, val: 11 },
      { id: 'spikeVar', label: 'Spike variation', min: 0, max: 1, step: .05, val: .45 },
      { id: 'rot', label: 'Rotation', min: 0, max: 360, step: 1, val: 0 },
      { id: 'color1', type: 'color', label: 'Outer colour', val: '#ff3b30' },
      { id: 'color2', type: 'color', label: 'Inner colour', val: '#ffd23f' },
      { id: 'color3', type: 'color', label: 'Dot colour', val: '#ff9f1a' },
      { id: 'ink', type: 'color', label: 'Outline colour', val: '#16120d' },
      { id: 'outline', label: 'Outline', min: 0, max: 8, step: .25, val: 2.5 },
      { id: 'halftone', label: 'Halftone', min: 0, max: 1, step: .05, val: .8 },
      { id: 'dotSize', label: 'Dot size', min: 3, max: 20, step: .5, val: 7 },
    ],
    glsl: `
float vr(float i, float N, float bt, float salt){
  float idx = mod(i, 2.*N);
  float h = h11(idx*7.31 + uSeed + bt*1.7 + salt);
  float outer = mod(idx,2.) < .5 ? 1. : 0.;
  return outer>.5 ? 1.+u_spikeVar*(h-.35)*1.1 : .52+u_spikeVar*(h-.5)*.25;
}
float shape(float ang, float r, float N, float bt, float salt){
  float k = (ang/6.28318530718+.5)*N*2.;
  float i0 = floor(k), t = fract(k);
  return mix(vr(i0,N,bt,salt), vr(i0+1.,N,bt,salt), t);
}
vec4 fx(vec2 uv, vec2 A){
  vec2 d = (uv-uPos)*A; float r = length(d);
  float ang = atan(d.y,d.x) + radians(u_rot);
  ang = mod(ang+3.14159265, 6.28318530718)-3.14159265;
  float N = floor(u_spikes+.5);
  float bt = uStep;
  float pop = back(uP*1.) ;
  float base = u_size*.01*pop;
  float R  = shape(ang,r,N,bt,0.)*base;
  float R2 = shape(ang,r,N,bt,40.)*base*.62;
  float aa = 1.5/uRes.y;
  float ow = u_outline*.001;
  float outerM = smoothstep(R+ow+aa, R+ow-aa, r);
  float fillM  = smoothstep(R+aa, R-aa, r);
  float innerM = smoothstep(R2+aa, R2-aa, r);
  // halftone dots, bigger toward the rim
  vec2 gp = rot(.5236)*gl_FragCoord.xy/u_dotSize;
  float rr = clamp((r/max(R,1e-4)-.25)*.62, 0., .55)*u_halftone;
  float dots = smoothstep(rr+.08, rr-.02, length(fract(gp)-.5));
  vec3 fillCol = mix(u_color1, u_color3, dots);
  vec3 col = u_ink;
  col = mix(col, fillCol, fillM);
  col = mix(col, u_color2, innerM);
  float a = outerM;
  return vec4(col*a, a);
}`,
  },

  bolt: {
    name: 'Lightning bolt', color: '#7fe9ff',
    desc: 'Zigzag comic lightning with a halftone halo; strikes from point A to B',
    icon: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
    defaults: { dur: 1.2, draw: .12, out: .3, boil: 12, needsP2: true },
    params: [
      { id: 'width', label: 'Thickness', min: .3, max: 4, step: .05, val: 1.7 },
      { id: 'jag', label: 'Jaggedness', min: 0, max: .6, step: .01, val: .22 },
      { id: 'branches', label: 'Branches', min: 0, max: 3, step: 1, val: 2 },
      { id: 'core', type: 'color', label: 'Core colour', val: '#ffffff' },
      { id: 'glow', type: 'color', label: 'Glow colour', val: '#7fe9ff' },
      { id: 'ink', type: 'color', label: 'Outline colour', val: '#0a1220' },
      { id: 'outline', label: 'Outline', min: 0, max: 1, step: .05, val: 0 },
      { id: 'haloW', label: 'Halo size', min: 2, max: 14, step: .5, val: 7 },
      { id: 'haloAmt', label: 'Halo strength', min: 0, max: 1, step: .05, val: .85 },
      { id: 'halftone', label: 'Halftone halo', min: 0, max: 1, step: .05, val: .7 },
      { id: 'dotSize', label: 'Dot size', min: 3, max: 18, step: .5, val: 6 },
      { id: 'flicker', label: 'Flicker', min: 0, max: 1, step: .05, val: .4 },
    ],
    glsl: `
float zig(float t, float seed, float bt){
  return (lin1(t*7.+seed+bt)-.5)*2. + (lin1(t*19.+seed*1.7+bt*1.3)-.5)*.6;
}
float offs(float t, float seed, float bt, float L){
  return zig(t,seed,bt)*u_jag*L*sin(3.14159265*clamp(t,0.,1.));
}
void boltTerms(vec2 p, vec2 a, vec2 b, float seed, float bt, float prog, float wsc,
               out float core, out float rim, out float halo, out float haloDot){
  vec2 d=b-a; float L=max(length(d),1e-4); vec2 dir=d/L; vec2 n=vec2(-dir.y,dir.x);
  float t=dot(p-a,dir)/L, x=dot(p-a,n);
  float tc=clamp(t,0.,1.), e=.012;
  float t1=min(tc+e,1.), t0=max(tc-e,0.);
  float slope=(offs(t1,seed,bt,L)-offs(t0,seed,bt,L))/(L*max(t1-t0,1e-3));
  float dd=abs(x-offs(tc,seed,bt,L))/sqrt(1.+slope*slope);
  float vis=step(0.,t)*step(t,prog);
  float w=u_width*.006*wsc*(1.-.55*tc);
  core = smoothstep(w,w*.7,dd)*vis;
  rim  = smoothstep(w*1.9,w*1.5,dd)*vis;
  float hw=w*u_haloW;
  float hv=1.-clamp(dd/hw,0.,1.);
  vec2 cell=fract(rot(.5236)*gl_FragCoord.xy/u_dotSize)-.5;
  float rr=hv*.66;
  haloDot = smoothstep(rr+.08,rr-.02,length(cell))*step(dd,hw)*vis;
  halo = hv*hv*vis;
}
vec4 fx(vec2 uv, vec2 A){
  vec2 p=uv*A, a=uPos*A, b=uP2*A;
  float bt=uStep*2.3;
  float prog=ease(uP)*1.02;
  float core,rim,halo,hdot;
  boltTerms(p,a,b,uSeed,bt,prog,1.,core,rim,halo,hdot);
  float L=length(b-a); vec2 dir=(b-a)/max(L,1e-4); vec2 n=vec2(-dir.y,dir.x);
  for(int i=0;i<3;i++){
    if(i>=int(u_branches+.5)) break;
    float fi=float(i);
    float ti=.2+.45*h11(uSeed+fi*3.1);
    float side=h11(uSeed+fi*7.7)>.5?1.:-1.;
    vec2 ai=a+dir*L*ti+n*offs(ti,uSeed,bt,L);
    vec2 dr=normalize(dir*.55+n*side*.85);
    vec2 bi=ai+dr*L*(.22+.22*h11(uSeed+fi*9.3));
    float c2,r2,h2,d2;
    boltTerms(p,ai,bi,uSeed+10.+fi*4.,bt,clamp((prog-ti)*3.,0.,1.),.62,c2,r2,h2,d2);
    core=max(core,c2); rim=max(rim,r2); halo=max(halo,h2); hdot=max(hdot,d2);
  }
  float fl = 1.-u_flicker*.5*step(.5,h11(uStep*3.7+uSeed));
  float hAmt=mix(halo*.55, hdot, u_halftone)*u_haloAmt*fl;
  vec4 H = vec4(u_glow*hAmt, hAmt);
  float rA=rim*u_outline;
  vec4 R = vec4(u_ink*rA, rA);
  vec4 Cc= vec4(u_core*core*fl, core*fl);
  return over(Cc, over(R, H));
}`,
  },

  swirl: {
    name: 'Glow swirl', color: '#6ee7ff',
    desc: 'Thin glowing strands that spiral around a point, like the energy over a head',
    icon: '<path d="M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0"/><path d="M12 8a4 4 0 1 1-4 4 7 7 0 0 1 7-7"/>',
    defaults: { dur: 2.4, draw: 1.2, out: .5, boil: 12, follow: true },
    params: [
      { id: 'radius', label: 'Radius', min: 2, max: 40, step: .5, val: 13 },
      { id: 'turns', label: 'Turns', min: .5, max: 5, step: .1, val: 2.2 },
      { id: 'strands', label: 'Strands', min: 1, max: 4, step: 1, val: 3 },
      { id: 'squash', label: 'Squash', min: .3, max: 1.5, step: .05, val: .6 },
      { id: 'width', label: 'Thickness', min: .5, max: 8, step: .1, val: 4.5 },
      { id: 'glow', label: 'Glow', min: 0, max: 1, step: .05, val: .85 },
      { id: 'spin', label: 'Spin', min: -3, max: 3, step: .1, val: .5 },
      { id: 'color', type: 'color', label: 'Colour A', val: '#6ee7ff' },
      { id: 'color2', type: 'color', label: 'Colour B', val: '#ffe45e' },
    ],
    glsl: `
vec4 fx(vec2 uv, vec2 A){
  vec2 d=(uv-uPos)*A; d.y/=max(u_squash,.2);
  float r=length(d), ang=atan(d.y,d.x);
  float R=u_radius*.01, TH=u_turns*6.28318530718;
  vec4 acc=vec4(0.);
  float prog=ease(uP);
  for(int s=0;s<4;s++){
    if(s>=int(u_strands+.5)) break;
    float ph=mod(float(s)*6.28318530718/u_strands + uSeed + uStep*.05*u_spin*6., 6.28318530718);
    float best=1e9, bth=0.;
    for(int k=0;k<7;k++){
      float th=ang+ph+6.28318530718*float(k-1);
      if(th<0.||th>TH*prog) continue;
      float rk=R*.1+R*th/TH;
      float dr=abs(r-rk);
      if(dr<best){ best=dr; bth=th; }
    }
    float w=u_width*.0007*(1.-.75*bth/TH)+.0004;
    float ln=smoothstep(w,w*.55,best);
    float glw=exp(-best/(w*6.))*u_glow*.4;
    vec3 col=(s-(s/2)*2)==0 ? u_color : u_color2;
    float a=clamp(ln+glw,0.,1.);
    acc=over(vec4(col*a,a), acc);
  }
  return acc;
}`,
  },

  sparkles: {
    name: 'Sparkles', color: '#fff3a8',
    desc: 'Twinkling four-point glints scattered around a point',
    icon: '<path d="M12 3c.6 5 1.4 6 6 6-4.600 0-5.400 1-6 6-.6-5-1.400-6-6-6 4.600 0 5.400-1 6-6z"/><path d="M19 15c.3 2.200.7 2.700 3 3-2.300.3-2.700.8-3 3-.3-2.200-.7-2.700-3-3 2.300-.3 2.700-.8 3-3z"/>',
    defaults: { dur: 2.5, draw: .3, out: .4, boil: 8, follow: true },
    params: [
      { id: 'count', label: 'Count', min: 1, max: 16, step: 1, val: 7 },
      { id: 'spread', label: 'Spread', min: .02, max: .6, step: .01, val: .2 },
      { id: 'size', label: 'Size', min: .5, max: 8, step: .1, val: 4.2 },
      { id: 'rate', label: 'Twinkle rate', min: .3, max: 4, step: .1, val: 1.2 },
      { id: 'color', type: 'color', label: 'Colour', val: '#fff6c2' },
      { id: 'color2', type: 'color', label: 'Edge colour', val: '#ffd23f' },
    ],
    glsl: `
float star(vec2 q, float s){
  q=abs(q)/max(s,1e-5);
  float d=pow(q.x,.45)+pow(q.y,.45);
  return smoothstep(1.,.78,d);
}
vec4 fx(vec2 uv, vec2 A){
  vec2 p=uv*A; vec4 acc=vec4(0.);
  for(int i=0;i<16;i++){
    if(i>=int(u_count+.5)) break;
    float fi=float(i);
    vec2 off=(vec2(h11(fi*3.1+uSeed),h11(fi*5.7+uSeed+1.))-.5)*2.*u_spread;
    vec2 c=uPos*A+off*vec2(1.5,1.);
    float life=sin(3.14159265*fract(uStep*.0833*u_rate*4.+h11(fi*9.1+uSeed)));
    float s=u_size*.006*life*ease(uP);
    float sh=star(p-c,s);
    float edge=star(p-c,s*1.35)-sh;
    vec3 col=mix(u_color2,u_color,sh);
    float a=clamp(sh+edge*.7,0.,1.);
    acc=over(vec4(col*a,a),acc);
  }
  return acc;
}`,
  },

  lines: {
    name: 'Speed lines', color: '#e9e9f2',
    desc: 'Radial manga action lines bursting from a point',
    icon: '<path d="M12 12L12 2M12 12l8-8M12 12h10M12 12l8 8M12 12v10M12 12l-8 8M12 12H2M12 12L4 4"/>',
    defaults: { dur: 1.6, draw: .2, out: .3, boil: 12, follow: true, occl: true },
    params: [
      { id: 'count', label: 'Line count', min: 20, max: 240, step: 1, val: 110 },
      { id: 'inner', label: 'Clear radius', min: 0, max: .9, step: .02, val: .36 },
      { id: 'len', label: 'Taper length', min: .1, max: 1, step: .02, val: .45 },
      { id: 'color', type: 'color', label: 'Colour', val: '#ffffff' },
      { id: 'amt', label: 'Strength', min: 0, max: 1, step: .05, val: .6 },
    ],
    glsl: `
vec4 fx(vec2 uv, vec2 A){
  vec2 d=(uv-uPos)*A; float r=length(d);
  float a=atan(d.y,d.x)/6.28318530718+.5;
  float n=u_count, id=floor(a*n);
  float h=h11(id+uStep*17.31+uSeed);
  float tri=abs(fract(a*n)-.5)*2.;
  float reach=smoothstep(u_inner,u_inner+u_len*.7,r);
  float line=step(tri,h*reach*.42)*step(.4,h);
  float al=line*ease(uP)*u_amt;
  return vec4(u_color*al, al);
}`,
  },
};

// build the full fragment source for a type
function typeSource(type) {
  const decl = TYPES[type].params.map(p => p.type === 'color' ? `uniform vec3 u_${p.id};` : `uniform float u_${p.id};`).join('\n');
  return HEADER(decl) + TYPES[type].glsl + MAIN;
}
