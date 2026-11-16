import type { Scene } from './types';

/** Polar night: three aurora curtains (sharp green lower hems, vertical rays fading up through teal into violet, folds
 * that brighten where the curtain turns edge-on) over two snowy ridges and a star field. The wind sways them faster
 * (via `drift`) and brighter; the pointer lifts and brightens the curtain under it. Light theme: a pale ice sky with
 * luminous tinted curtains over white snow; both graded by the prelude. */
export const scene: Scene = {
  id: 'aurora',
  label: 'Aurora',
  fallback: () => [[.03, .06, .14], [.05, .16, .2], [.1, .32, .3]],
  fragment: `
/* One curtain: its emission (linear) at p; k is the layer (0 far .. 2 near), g the pointer's pull. */
vec3 curtain(vec2 p,float k,float g,float lift){
  float t=drift*(1.6+k*.55);
  float x=p.x+k*3.7;
  /* The hem's path: a slow sweep plus tighter S-folds, with noise so no two bends repeat. */
  float a1=x*(3.+k*.6)+t*.9+k*1.7,a2=x*(6.6-k)-t*1.3+k;
  float bend=.06*sin(a1)+.035*sin(a2)+.11*sin(x*.9+k*2.1+t*.25)+(noise(vec2(x*2.,t*.4+k*9.))-.5)*.05;
  /* Where the hem runs steeply the curtain is seen through more of itself (a fold edge-on): brighter. */
  float slope=abs(.06*(3.+k*.6)*cos(a1)+.035*(6.6-k)*cos(a2));
  float fold=mix(.6,1.5,smoothstep(.05,.32,slope));
  float base=mix(.38,.52,k*.5)+bend-lift;
  float h=p.y-base;
  if(h<-.08||h>.8)return vec3(0.);
  /* Rays: streaks along the curtain (the coordinate follows the folds), drifting sideways and flickering softly. */
  float u=x*5.+bend*14.;
  float rays=noise(vec2(u*2.4,t*.5+k*5.))*.55+noise(vec2(u*6.5,t*1.1-k*3.))*.3+noise(vec2(u*16.,time*.7+k))*.15;
  rays=smoothstep(.36,.86,rays);
  float shimmer=.86+.14*noise(vec2(u*10.,time*2.+k*7.));
  /* A sharp lower hem, then a fall-off upward that tall rays stretch. */
  float hem=smoothstep(-.016,.008,h);
  float rise=exp(-max(h,0.)*mix(11.,2.,rays*rays)*(1.+k*.2));
  /* Patchy along its length, so the curtain breaks into bright runs and quiet gaps. */
  float run=smoothstep(.22,.7,noise(vec2(x*1.1-t*.2,k*4.3)));
  float I=hem*rise*(.12+.88*rays)*fold*shimmer*run;
  /* A soft glow hugging the hem, and a bright hem line. */
  float halo=exp(-abs(h-.02)*16.)*.22*run;
  float line=exp(-abs(h-.004)*90.)*run*fold*.6;
  /* Colour: green at the hem, teal above, violet and rose at the top; the hue drifts along the curtain. */
  float hx=noise(vec2(x*.8+t*.12,k*2.9));
  vec3 low=mix(vec3(.12,1.,.42),vec3(.06,.9,.82),smoothstep(.3,.75,hx));
  vec3 high=mix(vec3(.45,.2,1.),vec3(.95,.22,.6),smoothstep(.45,.85,hx));
  vec3 c=mix(low,high*.6,smoothstep(.1,.5,h));
  return (c*(I+halo)+vec3(.6,1.,.8)*line)*(1.-k*.15)*(1.+.45*wind+.9*g);
}
/* Ridged noise: sharp peaks, soft valleys. */
float ridge(float x,float seed){
  float n=0.,a=.5;
  for(int i=0;i<4;i++){n+=a*(1.-abs(noise(vec2(x+seed,seed))*2.-1.));x*=2.1;a*=.5;}
  return n/.9375;
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;vec2 p=vec2(uv.x*aspect,uv.y);float y=uv.y;
  vec2 v=p-vec2(ptr.x*aspect,ptr.y);
  float g=exp(-dot(v,v)/.045)*ptrAmt;
  /* The curtain lifts toward the pointer and leans with its motion. */
  float lift=-g*.04-ptrVel.y*g*.12;
  vec2 q=p-vec2(ptrVel.x*g*.25,0.);
  vec3 em=curtain(q,0.,g,lift)*.75+curtain(q,1.,g,lift)+curtain(q,2.,g,lift)*.9;
  float glowY=lum(em);
  /* Stars, hidden behind bright aurora. */
  vec2 cell=floor(p*170.),fc=fract(p*170.)-.5;float st=h21(cell);
  float star=step(.988,st)*smoothstep(.2,.0,length(fc+(vec2(h21(cell+3.1),h21(cell+7.7))-.5)*.5))*(.65+.35*sin(time*(1.3+st*3.)+st*40.));
  star*=smoothstep(.3,.6,y)*(1.-smoothstep(.0,.2,glowY));
  /* A faint green airglow above the ridges. */
  vec3 air=vec3(.1,.6,.42)*exp(-max(y-.2,0.)*7.)*.06*(1.+wind*.4);
  /* Three ranges, far to near (atmospheric perspective), each a ridged silhouette with a rim of aurora light on its
   * crest and a soft fall of shade below it; snow mottled by a slow 2D noise. */
  float px=1.5/res.y;
  float k3=ridge(p.x*3.1,17.),k2=ridge(p.x*2.2,11.),k1=ridge(p.x*1.5,3.);
  float r3=.19+.19*k3*k3,r2=.1+.22*k2*k2,r1=.01+.22*k1*k1;
  float m3=smoothstep(r3+px,r3-px,y),m2=smoothstep(r2+px,r2-px,y),m1=smoothstep(r1+px,r1-px,y);
  float rim3=exp(-max(r3-y,0.)*140.),rim2=exp(-max(r2-y,0.)*120.),rim1=exp(-max(r1-y,0.)*100.);
  float mottle=fbm(vec2(p.x*7.,y*16.),3);
  float fall1=smoothstep(.0,.16,r1-y),fall2=smoothstep(.0,.12,r2-y);
  if(dark>.5){
    vec3 col=mix(lin(vec3(.04,.11,.15)),lin(vec3(.02,.03,.1)),smoothstep(.12,.95,y));
    col+=air+em;
    col=mix(col,vec3(.92,.95,1.),star*.9);
    vec3 rimC=vec3(.1,.8,.55)*(.08+.05*wind);
    vec3 s3=lin(vec3(.09,.13,.2))+rimC*rim3*.5;
    vec3 s2=mix(lin(vec3(.14,.19,.28)),lin(vec3(.08,.11,.17)),fall2)+rimC*rim2*.8;
    vec3 s1=mix(lin(vec3(.24,.3,.4)),lin(vec3(.1,.13,.2)),fall1)*(.85+.3*mottle)+rimC*rim1;
    col=mix(col,mix(s3,col,.3),m3);
    col=mix(col,s2,m2);
    col=mix(col,s1,m1);
    gl_FragColor=finish(gradeDark(col,2.4));
  }else{
    /* Light: the sky follows the clock (bright ice blue by day, rosy at dawn and dusk, deep periwinkle at night) with
     * the curtains as clear, luminous tints over white snow; paler by day, strongest at night. */
    float dusk=max(sun.z*(1.-smoothstep(.32,.42,sun.y)),smoothstep(.05,.3,night)*(1.-smoothstep(.55,.9,night)));
    vec3 skyLo=mix(mix(vec3(.8,.92,.98),vec3(.98,.84,.84),dusk),vec3(.7,.74,.92),smoothstep(.45,1.,night));
    vec3 skyHi=mix(mix(vec3(.56,.76,.96),vec3(.74,.64,.88),dusk),vec3(.42,.46,.8),smoothstep(.45,1.,night));
    vec3 col=mix(lin(skyLo),lin(skyHi),smoothstep(.12,.95,y));
    float A=1.-exp(-glowY*mix(7.5,6.,night));
    A*=mix(.92,1.,night);
    vec3 tint=em/max(max(em.r,em.g),max(em.b,1e-3))*vec3(.85,1.,.8);
    /* By day a deeper green-teal, so the curtains read against the bright ice sky. */
    tint=mix(tint,tint*vec3(.45,.82,.68),(1.-night)*(1.-dusk));
    col=mix(col,tint*mix(.75,1.,tint.g),A*.85)+air*.6;
    vec3 rimC=vec3(.6,1.,.85);
    vec3 s3=mix(lin(vec3(.72,.8,.92)),rimC,rim3*.3);
    vec3 s2=mix(mix(lin(vec3(.84,.89,.97)),lin(vec3(.74,.81,.93)),fall2),rimC,rim2*.3);
    vec3 s1=mix(lin(vec3(1.,1.,1.)),lin(vec3(.84,.89,.97)),fall1)*(.96+.06*mottle);
    col=mix(col,mix(s3,col,.2),m3);
    col=mix(col,s2,m2);
    col=mix(col,s1,m1);
    /* The curtain's light pools on the snow and air under the pointer, where a lift alone would clip against white. */
    col=mix(col,vec3(.5,.92,.8),g*.34);
    gl_FragColor=finish(gradeLight(col,1.));
  }
}`,
};
