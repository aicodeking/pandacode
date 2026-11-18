import type { Scene } from './types';

/** Desert dunes: four ranges of sharp-crested dunes receding into a warm haze, each with a crisp knife-edge where the
 * lit windward slope meets the shaded slip face (the light side follows the sun across the day), fine wind ripples on
 * the slopes and a sun or moon over the haze. Amber, peach and rose by day, a golden-hour glow at dawn and dusk, cool
 * blue sand under stars at night. Airborne sand drifts through sky and over the slopes at rest; the wind thickens it,
 * walks the ripples and blows streamers off the crests; the pointer stirs drifting sand. */
export const scene: Scene = {
  id: 'dunes',
  label: 'Dunes',
  fallback: colors => [colors.top, colors.horizon, [.86, .6, .42]],
  fragment: `
/* A dune range's crest height at x (w = cell coordinate): a convex windward rise to a sharp crest at fraction a, then
 * a short, steep, slightly concave slip face; the cells wander so no two dunes repeat. */
float crest(float x,float k,out float w,out float a){
  w=x*(1.1+k*.55)+k*5.3+(noise(vec2(x*.6+k*7.,k))-.5)*1.2;
  float c=floor(w),f=fract(w);
  a=.66+.18*(h21(vec2(c,k))-.5);
  float tri=f<a?1.-pow(1.-f/a,1.8):pow((1.-f)/(1.-a),1.25);
  float amp=.45+.55*noise(vec2(x*.45,k*3.+3.));
  return tri*amp+(noise(vec2(x*3.,k*2.))-.5)*.05;
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;float y=uv.y;vec2 p=vec2(uv.x*aspect,y);
  float sv=sun.z,mv=moon.z;
  vec2 sp=vec2(sun.x*aspect,sun.y+.12),mp=vec2(moon.x*aspect,moon.y+.14);
  float sd=distance(p,sp),md=distance(p,mp);
  float low=1.-smoothstep(.32,.42,sun.y);
  float gold=low*sv;
  /* Sky: the clock's palette pushed warm (apricot horizon, dusty rose above) by day; cool indigo at night. */
  vec3 hz=mix(hor,mix(vec3(1.,.8,.6),glow,.4),.55*(1.-night));
  vec3 md2=mix(mid,vec3(.95,.72,.66),.35*(1.-night));
  vec3 sky=mix(hz,md2,smoothstep(.3,.62,y));sky=mix(sky,top,smoothstep(.6,1.,y));
  vec3 col=lin(sky);
  if(dark>.5)col=mix(col,col*vec3(.9,.84,1.04),.4*(1.-night));
  vec3 sunC=lin(mix(vec3(1.,.93,.78),glow,.5+.4*low));
  col+=sunC*(exp(-sd*mix(5.,2.8,low))*mix(.2,.5,low)+exp(-sd*18.)*.3)*sv;
  col=mix(col,sunC*1.25+.15,smoothstep(.032,.027,sd)*sv);
  vec2 cell=floor(p*150.),fc=fract(p*150.)-.5;float h=h21(cell);
  float star=step(.986,h)*smoothstep(.22,.0,length(fc+(vec2(h21(cell+3.1),h21(cell+7.7))-.5)*.5))*(.6+.4*sin(time*(1.5+h*3.)+h*40.));
  col=mix(col,vec3(.92,.94,1.),clamp(star*night*smoothstep(.45,.7,y)*1.7,0.,1.));
  col+=vec3(.6,.66,.85)*(exp(-md*9.)*.2+exp(-md*30.)*.15)*mv;
  col=mix(col,vec3(.92,.9,.84),smoothstep(.03,.026,md)*(1.-.97*smoothstep(.032,.02,distance(p,mp+vec2(.013,.007))))*mv);
  /* Light on the sand: which side faces it (the sun's side of the frame), and its colours. */
  float side=sign(mix(sun.x,moon.x,step(sv,.02))-.5+1e-3);
  vec3 litC=mix(lin(vec3(1.,.74,.5)),lin(vec3(1.,.6,.38)),gold);
  litC=mix(litC,lin(vec3(.56,.62,.82)),night);
  vec3 shdC=mix(lin(vec3(.74,.4,.42)),lin(vec3(.58,.3,.42)),gold);
  shdC=mix(shdC,lin(vec3(.22,.26,.44)),night);
  vec3 haze=lin(mix(hz,vec3(1.,.85,.72),.3*(1.-night)));
  vec2 v=p-vec2(ptr.x*aspect,ptr.y);
  float gp=exp(-dot(v,v)/.08)*ptrAmt;
  /* The pointer's sand veil: a fine drifting fbm, swept along with the pointer's motion. */
  float stir=smoothstep(.35,.7,fbm(vec2(p.x*9.,p.y*18.)-ptrVel*80.+vec2(time*.9,time*.2),3));
  /* In the sky over the dunes, a soft warm brightening and a faint veil of airborne sand. */
  col=mix(col,col*1.25+litC*.06,gp*.8);
  col=mix(col,mix(litC,haze,.3),gp*stir*mix(.4,.55,dark));
  /* Airborne sand: one wide, slow field (it lives at rest on drift) that the wind speeds up and thickens. */
  float blow=fbm(vec2(p.x*2.1-drift*16.,y*7.-drift*2.5+sin(p.x*1.7-drift*5.)*.5),3);
  float veil=smoothstep(.36,.72,blow);
  col=mix(col,mix(litC,haze,.45),veil*smoothstep(1.05,.5,y)*(.1+.32*wind));
  float px=1.2/res.y;
  /* Four ranges, far to near. */
  for(int i=0;i<4;i++){
    float k=float(i),near=k/3.;
    float base=mix(.4,.02,near),amp=mix(.07,.26,near);
    float x=p.x*mix(1.6,.7,near)+k*2.3;
    float w,a;
    float c=crest(x,k,w,a);
    float top=base+amp*c;
    /* Sand streamers blown off the crest by the wind, thinning as they rise. */
    float above=y-top;
    if(above>0.){
      float lift=above/(amp*.6+.02);
      float plume=fbm(vec2(x*6.-drift*14.*(1.+near),above*30.-drift*3.),3);
      float s=smoothstep(.42,.72,plume)*exp(-lift*2.)*smoothstep(.4,.9,c)*(.3+.7*wind)*(.7+.3*near);
      col=mix(col,mix(litC,haze,.25)*1.08,s*.85);
      continue;
    }
    /* The knife-edge: from the crest a sharp line curves down into the slip face; beyond it the face looks away from
     * the light's side (or toward it, when the light is on the slip-face side). */
    float depth=top-y,dd=depth/amp;
    /* The edge sweeps down from each crest into the slip-face side, so every dune shows a lit and a shaded flank. */
    float G=.55*sqrt(clamp(dd,0.,2.))+(noise(vec2(w*2.,dd*3.+k))-.5)*.06;
    float f=fract(w-G);
    float slip=smoothstep(a-.006,a+.006,f)*(1.-smoothstep(.994,1.,f));
    float lee=side>0.?1.-slip:slip;
    /* Wind ripples: fine, wavy lines across the windward slopes, larger on near dunes. */
    vec2 rq=vec2(f*mix(16.,9.,near),dd*mix(28.,14.,near));
    f=fract(w);
    /* The ripples walk with the drift, and stand out more while the wind is up. */
    float rip=sin(rq.y*6.28+sin(rq.x*2.1+dd*3.)*1.6+rq.x*1.7-drift*22.);
    rip=smoothstep(.55,1.,rip)*(1.-slip)*mix(.05,.16,near)*(1.+.5*wind)*smoothstep(0.,.05,dd);
    vec3 sand=mix(litC*(1.-rip),shdC*(1.-rip*.5),lee);
    /* In dark the lit/shade gap is spread so the ridges survive the compression. */
    if(dark>.5)sand*=mix(1.4,.6,lee);
    /* Shading falls a little toward each trough; the far ranges dissolve into the haze. */
    sand*=1.-.22*smoothstep(0.,1.4,dd)*(1.-lee*.5);
    /* Sand sheets sliding over the slopes: the airborne field's shadow and sheen. */
    sand*=1.+(blow-.5)*(.16+.75*wind)*(.5+.5*near);
    sand=mix(sand,haze,mix(.62,.0,near)+.1*(1.-near)*night);
    /* The pointer stirs a drifting veil of sand where the dunes show. */
    sand=mix(sand,litC*1.35+.04,gp*stir*.75*(.55+.45*near));
    sand*=1.+gp*mix(.2,.35,dark);
    float m=smoothstep(-px,px,depth);
    col=mix(col,sand,m);
  }
  if(dark>.5){
    col*=mix(vec3(1.),vec3(1.02,.92,.95),1.-night);
    col.g-=max(col.r-col.b,0.)*.1*smoothstep(.0,.08,lum(col));col=max(col,0.);
    /* The sun just below the ridges lights the horizon on its own side: cool pink at dawn, amber at dusk. */
    float set=smoothstep(.38,.32,sun.y)*(1.-smoothstep(.45,.8,night));
    float east=step(sun.x,.5),dx=(uv.x-sun.x)*aspect;
    vec3 glowC=mix(vec3(.95,.34,.1),vec3(.62,.3,.62),east);
    col+=glowC*set*exp(-dx*dx*.9)*exp(-abs(y-.4)*mix(5.,6.,east))*mix(.5,.42,east);
    gl_FragColor=finish(gradeDark(col,2.4));
  }else{
    gl_FragColor=finish(gradeLight(col,.75));
  }
}`,
};
