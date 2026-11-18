import type { Rgb, SkyColors } from '../sky-math';

/**
 * A thread scene: one procedural WebGL backdrop behind the conversation (src/sky-window.ts is the host). Every file in
 * src/scenes/ that exports `scene: Scene` registers itself (src/scenes/index.ts); a thread always shows the scene its id
 * hashes to (`sceneFor`), the sky when there is no thread. `?scene=<id>` pins one in the preview.
 *
 * The host compiles `PRELUDE + scene.fragment` lazily, once per scene, and draws one full-screen triangle. The fragment
 * owns `main()` and must end with `gl_FragColor = finish(col);`.
 *
 * Uniforms (all supplied every paint; an unused one costs nothing):
 *  - `res` canvas size in device px; `aspect` = res.x / res.y. Use `uv = gl_FragCoord.xy / res` (y up) and
 *    `p = vec2(uv.x * aspect, uv.y)` for isotropic noise.
 *  - `drift` integrated motion phase: grows ~0.012/s at rest and ~0.12/s at full wind; never jumps, so use it for
 *    anything that travels or sways. `time` wall seconds since mount, for flicker that must not speed up with the wind.
 *  - `wind` 0..1, eased on a ~1 s spring: 1 while the thread's agent runs. Scenes move faster (via `drift`) and may
 *    brighten or agitate with it.
 *  - `ptr` pointer in uv (y up), `ptrVel` its clamped velocity (uv/s × .07), `ptrAmt` 0..1 how present it is (0 while it
 *    rests on a message, the composer, header or dock). Answer it only where the scene shows: bend, part, brighten.
 *  - `dark` 0 light / 1 dark theme. `floorY` the light grade's floor (`lightFloor(night)`), `ceilY` the dark ceiling.
 *  - Clock (for scenes that want time of day): `night` 0 day..1 night; `sun`/`moon` = (x, y, visibility) in uv;
 *    `top`, `mid`, `hor`, `glow`, `lit`, `shade` the `skyColorsAt` palette (sRGB; `lin()` them).
 *
 * Rules (thread text sits on the bare scene, so the grade is what keeps it readable; tests/sky.spec.ts measures
 * every registered scene at 06:30, 12:00, 18:40 and 23:00 in both themes):
 *  - Light: every output pixel has luminance Y ≥ `floorY`. Dark: every pixel Y ≤ `ceilY`, bright points included.
 *    Grade in linear light with `gradeLight(col, k)` / `gradeDark(col, k)` (hue-preserving) or an equivalent.
 *  - `finish()` adds the 1/255 dither, so gradients never band; always end with it.
 *  - Cost: stay within ~1.3× the sky's fragment cost (≈ 3 layers of 6-octave fbm plus a 4-step march). Prefer a few
 *    octaves and cheap 1D noise; the host renders at 0.6 device px and a governor drops it to 0.45 when paints run long.
 *  - No textures, no extra passes, no derivatives extension (WebGL 1, `precision highp float`).
 */
export interface Scene {
  /** Stable id: the per-thread pick sorts by it, so renaming one reshuffles every thread. */
  id: string;
  label: string;
  /** GLSL appended to PRELUDE; defines `void main()`. */
  fragment: string;
  /** The CSS gradient (top, middle, bottom; sRGB 0..1) shown until WebGL paints or if it cannot; the layer's own
   * overlay grades it per theme. Called with the clock's palette. */
  fallback(colors: SkyColors): readonly [Rgb, Rgb, Rgb];
}

export const VERTEX = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
export const UNIFORMS = ['res', 'aspect', 'drift', 'time', 'wind', 'ptr', 'ptrVel', 'ptrAmt', 'dark', 'floorY', 'ceilY',
  'night', 'sun', 'moon', 'top', 'mid', 'hor', 'glow', 'lit', 'shade'] as const;

export const PRELUDE = `precision highp float;
uniform vec2 res,ptr,ptrVel;
uniform float aspect,drift,time,wind,ptrAmt,dark,floorY,ceilY,night;
uniform vec3 sun,moon,top,mid,hor,glow,lit,shade;
float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y);}
const mat2 R=mat2(.8,.6,-.6,.8);
float fbm(vec2 p,int n){float v=0.,a=.5,t=0.;for(int i=0;i<6;i++){if(i>=n)break;v+=a*noise(p);t+=a;p=R*p*2.02+vec2(11.7,3.1);a*=.5;}return v/t;}
float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 lin(vec3 c){return pow(c,vec3(2.2));}vec3 srgb(vec3 c){return pow(c,vec3(1./2.2));}
/* Light: Y lifted onto [floorY, 1] (t = sqrt(Y² + floor²), so shading compresses but never flattens), half by hue-
 * preserving scale and half toward white; w (0..1) leans further toward the hue-preserving half. */
vec3 gradeLight(vec3 col,float w){
  float Y=lum(col),t=sqrt(Y*Y+floorY*floorY);
  vec3 kept=Y>1e-5?col*(t/Y):vec3(t);
  float mx=max(kept.r,max(kept.g,kept.b));
  if(mx>1.){kept/=mx;float y2=lum(kept);kept=mix(kept,vec3(1.),clamp((t-y2)/(1.-y2),0.,1.));}
  vec3 o=mix(kept,mix(col,vec3(1.),clamp((t-Y)/(1.-Y),0.,1.)),(.35+.4*clamp((t-Y)/t,0.,1.))*(1.-w));
  float yo=lum(o);return yo<floorY?mix(o,vec3(1.),(floorY-yo)/(1.-yo)):o;
}
/* Dark: Y compressed onto [0, ceilY] on 1 - e^(-kY) (higher k lifts the lows), hue-preserving, hard-capped. */
vec3 gradeDark(vec3 col,float k){
  float Y=lum(col),t=min(ceilY*(1.-exp(-k*Y))/(1.-exp(-k)),ceilY);
  col=Y>1e-6?col*(t/Y):vec3(t);
  float y2=lum(col);return y2>ceilY?col*(ceilY/y2):col;
}
vec4 finish(vec3 col){return vec4(srgb(clamp(col,0.,1.))+(h21(gl_FragCoord.xy)-.5)/255.,1.);}
`;
