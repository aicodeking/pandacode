import { DARK_CEILING } from '../sky-math';
import type { Scene } from './types';

/** The procedural sky: the clock's palette, sun and moon arcs, cirrus and three parallax cumulus layers (see AGENTS.md
 * 'Thread window'). It keeps its own grade (a dusk-aware variant of the prelude's) and is the scene with no thread. */
export const scene: Scene = {
  id: 'sky',
  label: 'Sky',
  fallback: colors => [colors.top, colors.mid, colors.horizon],
  fragment: `/* Cumulus thickness: a billowy base (fbm over a slow domain warp), eroded at the edges by fine noise so they wisp out
 * while the interior keeps crisp billows; the erosion rides its own share of the warp, so it never tears into teeth in
 * step with the billows. w is the warp (reused by the light march), n the octaves. */
float puff(vec2 q,vec2 w,float cover,float gain,int n){
  float d=fbm(q+w,n)-cover;
  d-=(1.-smoothstep(0.,.14,d))*(noise(q*5.3+w*1.7)-.45)*.08;
  return clamp(d*gain,0.,1.);
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;vec2 p=vec2(uv.x*aspect,uv.y);
  float y=uv.y;
  vec3 col=mix(hor,mid,smoothstep(.0,.5,y));col=mix(col,top,smoothstep(.45,1.,y));
  col=lin(col);
  /* Dark theme by day: the sky itself is pulled toward a deep, saturated dusk blue before the clouds go on. */
  if(dark>.5)col=mix(col,col*vec3(.38,.68,1.6),.75*(1.-night));
  vec2 sp=vec2(sun.x*aspect,sun.y);float sd=distance(p,sp),sv=sun.z;
  /* Warm aureole around the sun, wider and warmer when it is low; the disc and bloom come after the grade. */
  float low=1.-smoothstep(.35,.8,sun.y);
  col+=lin(glow)*(exp(-sd*mix(5.,3.,low))*mix(.22,.45,low)+exp(-sd*16.)*.3)*sv;
  /* Night: stars twinkle in the upper sky; the moon is a lit crescent with a faint halo. */
  vec2 cell=floor(p*vec2(150.)),fc=fract(p*150.)-.5;float st=h21(cell);
  float star=step(.986,st)*smoothstep(.22,.0,length(fc+(vec2(h21(cell+3.1),h21(cell+7.7))-.5)*.5))*(.6+.4*sin(time*(1.5+st*3.)+st*40.));
  float starA=clamp(star*night*smoothstep(.2,.55,y)*1.8,0.,1.);
  vec2 mp=vec2(moon.x*aspect,moon.y);float md=distance(p,mp);
  float disc=smoothstep(.034,.03,md),bite=smoothstep(.036,.022,distance(p,mp+vec2(.015,.008)));
  /* The tight glow is the disc's own size: faded broadly off the shadowed limb (a
   * hard cut would ring it), or it would draw that limb as a grey ball. */
  col+=vec3(.6,.66,.85)*(exp(-md*9.)*.25+exp(-md*28.)*.2*(1.-.75*smoothstep(.06,.005,distance(p,mp+vec2(.015,.008)))))*moon.z;
  /* The shadowed limb all but vanishes and feathers into the sky, so no grey ball sits behind the crescent. */
  float moonA=disc*(1.-bite*.99)*moon.z;
  /* The light: the sun by day, the moon by night, from above when neither is up. */
  vec2 lp=sv>.02?sp:mp;float lv=max(sv,moon.z*.8);
  /* One light direction for the frame (from the pane's centre), in cloud space: per-pixel directions streak near the light. */
  vec2 ld=normalize(mix(vec2(0.,1.),normalize(lp-vec2(.5*aspect,.5)+1e-4),.6*step(.02,lv)))*vec2(1.,1.65)*.12;
  vec2 v=p-vec2(ptr.x*aspect,ptr.y);
  float occ=0.,glint=0.;
  /* High cirrus first: thin streaks stretched by the wind, catching the light. */
  {
    vec2 q=p*vec2(1.3,7.)+vec2(drift*.5+31.,0.);
    float w=fbm(q*vec2(.25,.5),2);
    float f=fbm(q+vec2(w*3.,w*.6),4);
    float m=smoothstep(.45,.62,noise(p*1.4+vec2(drift*.08,4.)));
    float a=smoothstep(.56,.8,f)*m*smoothstep(.5,.75,y)*.42;
    vec3 c=mix(lin(lit),lin(glow),.25*sv)*mix(.85,1.,f);
    col=mix(col,c,a);occ+=a*(1.-occ)*.5;
  }
  /* Three cumulus layers, far to near: far ones smaller, softer and hazier; the near one large and crisp. */
  for(int k=0;k<3;k++){
    float fk=float(k),near=fk/2.;
    float scale=mix(4.6,1.7,near),speed=mix(.3,1.,near);
    float band=smoothstep(mix(.28,.02,near),mix(.48,.3,near),y)*(1.-smoothstep(mix(.86,.95,near),1.08,y));
    vec2 q=p*scale*vec2(1.,1.65)+vec2(drift*speed+fk*17.3,fk*5.1);
    /* Cover varies across the sky on a slow field, so some blue always shows through. */
    float region=noise(p*.9+vec2(drift*speed*.15+fk*3.7,fk));
    float cover=mix(.5,.47,near)+(.5-region)*.22+night*.05;
    /* The pointer parts the clouds (pushes the field aside, thins the centre) and drags a billow along its motion. */
    float g=exp(-dot(v,v)/(.035+near*.03))*ptrAmt*(.4+near*.8);
    q-=(normalize(v+1e-4)*.7+ptrVel*1.6)*g*scale*.13;
    cover+=g*.09+exp(-sd*9.)*.3*sv;
    if(band<=0.)continue;
    vec2 w=vec2(fbm(q*.33+vec2(1.7,9.2),2),fbm(q*.33+vec2(8.3,2.8),2))*1.5-.75;
    float gain=mix(2.4,5.2,near);
    int oct=k==0?4:6;
    float d=puff(q,w,cover,gain,oct)*band;
    if(d<=.002)continue;
    /* Self-shadowing: march four linear steps toward the light (Beer-Lambert transmittance) for the big form, the start
     * jittered per pixel so low light never quantizes into stair-step bands, and one full-detail sample just sunward for
     * the billows' own lit edges. */
    float tau=0.,jit=fract(52.98*fract(dot(gl_FragCoord.xy+fk*5.,vec2(.0671,.00584))));
    for(int i=0;i<4;i++){tau+=puff(q+ld*(float(i)+jit)*.7,w,cover,gain,3)*band;}
    float T=exp(-tau*mix(.62,1.,near));
    float micro=clamp((d-puff(q+ld*.22,w,cover,gain,oct)*band)*mix(1.,2.,near),-.6,.6);
    float light=T*(.6+.4*(1.-exp(-d*3.)))+micro*.3+(1.-d)*.1;
    vec3 c=mix(lin(shade),lin(lit),clamp(light,0.,1.));
    /* Silver lining: thin, sunward edges near the sun glow; the sky's own blue fills the shadows a little. */
    float edge=1.-smoothstep(0.,.22,d);
    float near_sun=exp(-distance(p,lp)*5.)*lv;
    c+=lin(glow)*edge*near_sun*(.35+.5*T)*mix(.5,1.,near);
    c=mix(c,lin(top)*.9+lin(shade)*.3,.12*(1.-T));
    c+=lin(lit)*.14*g;
    /* Forward scatter: cloud over or beside the disc glows with it instead of biting it. */
    c+=lin(glow)*exp(-sd*24.)*sv*(1.-T)*.5;
    /* Dark by day: slate-blue clouds; neutral grey beside the deep blue would read as khaki. */
    /* Warm daylight tops at low luminance read as olive: silver them, and spread lit against shade so the form holds. */
    if(dark>.5){c=mix(c,vec3(lum(c))*vec3(.9,.95,1.1),.55*(1.-smoothstep(0.,.35,night)));c*=mix(vec3(1.),vec3(.66,.8,1.25),1.-night)*mix(.5,1.5,clamp(light,0.,1.));}
    vec3 haze=lin(mix(hor,mid,.4+.4*near));c=mix(c,haze,mix(.42-.14*dark,.0,near));
    float a=(1.-exp(-d*mix(3.,7.,near)))*mix(.82,1.,near);
    col=mix(col,c,a);occ+=a*(1.-occ);glint+=edge*near_sun*a*(1.-occ);
  }
  /* Theme grade, hue-preserving. Light maps Y onto [floor, 1] (shading compresses, never flattens); dark compresses Y
   * onto [0, ${DARK_CEILING}] and pulls daytime toward a saturated dusk blue, so it reads as sky, not mud. */
  float Y=lum(col);
  if(dark<.5){
    float t=sqrt(Y*Y+floorY*floorY);
    /* Half hue-preserving lift, half a lift toward white: either alone over-saturates dusk or washes it out. */
    vec3 kept=Y>1e-5?col*(t/Y):vec3(t);
    float mx=max(kept.r,max(kept.g,kept.b));
    if(mx>1.){kept/=mx;float y2=lum(kept);kept=mix(kept,vec3(1.),clamp((t-y2)/(1.-y2),0.,1.));}
    col=mix(kept,mix(col,vec3(1.),clamp((t-Y)/(1.-Y),0.,1.)),.35+.4*clamp((t-Y)/t,0.,1.)*(1.-night));
  }else{
    float day=1.-night;
    /* A dusk horizon compressed this dark turns wine: let its colour fade toward grey near the bottom edge (barely by
     * day, where the fade would read as a flat taupe wash). */
    col=mix(col,vec3(lum(col)),mix(.15,.55,smoothstep(.05,.2,night))*(1.-smoothstep(.0,.4,y)));
    col=mix(col,col*vec3(.6,.8,1.25),.3*day*smoothstep(.05,.4,y));
    /* Warm light at low luminance reads as olive: turn it toward rose instead. */
    col.g-=max(col.r-col.b,0.)*.38*smoothstep(.0,.08,Y);col=max(col,0.);
    Y=lum(col);
    float t=min(${DARK_CEILING}*(1.-exp(-1.4*Y))/(1.-exp(-1.4)),${DARK_CEILING});
    col=Y>1e-6?col*(t/Y):vec3(t);
    col=max(vec3(t)+(col-vec3(t))*(1.+.3*day),0.);
    float y2=lum(col);if(y2>${DARK_CEILING})col*=${DARK_CEILING}/y2;
  }
  /* The sun keeps its own light: a hot core with limb darkening, a bloom, and a warm halo ring that reads even against a
   * bright noon sky. Clouds in front hide it, but their lit rims (glint) carry some of its light through. */
  float clear=1.-occ;
  vec3 sunCol=mix(vec3(1.,.96,.86),vec3(1.,.72,.42),low);
  float core=smoothstep(.034,.029,sd);
  /* Dark theme: a calm disc (core luminance about .6, a soft bloom), so it never pulls the eye off the thread. */
  float dim=dark>.5?.58:1.;
  col+=sunCol*(exp(-sd*42.)*.55+exp(-sd*11.)*.12)*sv*(clear*.85+.15)*(dark>.5?.5:1.);
  col=mix(col,max(col,sunCol*mix(.98,1.12,1.-sd/.034)*dim),core*sv*clear);
  col+=sunCol*glint*.25*sv;
  col=mix(col,vec3(.9,.89,.82),moonA*clear);
  col=mix(col,vec3(.92,.94,1.),starA*clear);
  /* Dark: the bodies and stars keep the ceiling too (a calm, dim disc), so light text over them still reads. */
  if(dark>.5){float yb=lum(col);if(yb>${DARK_CEILING})col*=${DARK_CEILING}/yb;}
  /* A 1/255 dither, so the moon's halo and the dusk gradient never band. */
  gl_FragColor=vec4(srgb(clamp(col,0.,1.))+(h21(gl_FragCoord.xy)-.5)/255.,1.);
}`,
};
