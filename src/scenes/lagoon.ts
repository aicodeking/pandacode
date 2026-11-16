import type { Scene } from './types';

/** Underwater lagoon, seen from just below the surface: the rippling surface overhead (bright through the window, a
 * mirror of the deep beyond it), god rays slanting down through turquoise water onto a sandy floor in perspective,
 * where a caustic light web plays over sand ripples, and a few bubbles rising. The wind speeds the ripples and the
 * caustics (via `drift`); the pointer sends rings through the caustics and the surface where the scene shows. The light
 * cools and dims a little at night (in the light theme, whose grade holds luminance, the hue carries it: a moonlit pool). Light theme: pale luminous aqua over white sand; both graded by the prelude. */
export const scene: Scene = {
  id: 'lagoon',
  label: 'Lagoon',
  fallback: () => [[.35, .8, .85], [.08, .5, .6], [.3, .45, .45]],
  fragment: `
/* A caustic web: where two drifting, warped noise fields cross the same level the light focuses into bright lines;
 * two scales so the web has fine threads inside larger cells. */
float caustic(vec2 p,float t){
  vec2 w=vec2(noise(p*.7+vec2(t*.21,0.)),noise(p*.7+vec2(4.3,-t*.17)));
  p+=w*1.8;
  float a=noise(p*1.6+vec2(t*.33,t*.12)),b=noise(R*p*1.6+vec2(-t*.27,t*.3)+3.7);
  float c=exp(-abs(a-b)*14.);
  float a2=noise(p*3.3+vec2(-t*.4,t*.2)+9.),b2=noise(R*p*3.3+vec2(t*.35,-t*.25)+1.3);
  return c*.75+exp(-abs(a2-b2)*16.)*.45;
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;float y=uv.y,ax=(uv.x-.5)*aspect;
  float t=time*.35+drift*16.;
  /* The pointer's rings: a radial wobble around it that fades out with distance and with its presence. */
  vec2 v=vec2((uv.x-ptr.x)*aspect,uv.y-ptr.y);float pd=length(v);
  float ring=sin(pd*60.-time*9.)*exp(-pd*4.5)*ptrAmt;
  vec2 wob=v/(pd+1e-3)*ring*.028;
  /* The pointer's glow: the water brightens around it, most on the rings' crests. */
  float glint=exp(-pd*5.)*ptrAmt*(.6+.4*ring);
  vec2 q=vec2(ax,y)+wob;
  /* Depth haze: the water column, lit from above. */
  float night2=night*.6;
  vec3 deep=mix(vec3(.0,.09,.17),vec3(.0,.05,.14),night2),shallow=mix(vec3(.12,.72,.78),vec3(.08,.45,.62),night2);
  vec3 water=mix(deep,shallow,smoothstep(.0,1.,y)*.85+.1);
  vec3 col=water;
  /* The floor: sand in perspective below its horizon, dunes rippled across it, the caustic web, fading into the haze. */
  float hf=.42;
  if(q.y<hf){
    float z=.32/(hf-q.y+.04);
    vec2 fp=vec2(q.x*z*1.6,z*2.2);
    float dune=sin(fp.x*1.3+fp.y*4.+noise(fp*.8)*3.)*.5+.5;
    vec3 sand=mix(vec3(.62,.6,.48),vec3(.8,.76,.6),dune*.6+noise(fp*6.)*.4);
    float cs=caustic(fp*2.2,t);
    /* The water filters the sand's colour toward aqua; the caustics land on it in the water's own light. */
    vec3 lit=sand*vec3(.62,.9,.92)*(.36+.25*dune)+vec3(.55,1.,.95)*cs*mix(.75,1.5,dark)*(1.+glint*1.6)*(1.-night2*.5);
    float fog=1.-exp(-(z-.7)*.55);
    col=mix(lit,water,clamp(fog,0.,1.));
  }
  /* The surface overhead: rippled, bright inside the window above, a darker mirror of the deep toward its edge. */
  float hs=.74;
  if(q.y>hs){
    float zs=.22/(q.y-hs+.03);
    vec2 sp=vec2(q.x*zs*1.8,zs*2.6+t*.15);
    float rip=caustic(sp*.9+vec2(7.,0.),t*1.3);
    float window=smoothstep(.0,.22,q.y-hs)*(1.-smoothstep(mix(.35,.5,dark),mix(1.25,1.6,dark),abs(ax)));
    vec3 surf=mix(water*1.2,vec3(.55,.96,.98),window*.7)+vec3(.8,1.,1.)*rip*(.25+.5*window+glint);
    col=mix(col,surf,smoothstep(hs,hs+.14,q.y));
  }
  /* God rays: slanted shafts from the surface, wavering with it, fading with depth and stronger where it is bright.
   * A low sun leans them toward itself and gilds them; night dims them. */
  float lowSun=(1.-smoothstep(.31,.38,sun.y))*(1.-smoothstep(.3,.7,night));
  float u=ax+(1.-y)*(.42+lowSun*(.5-sun.x)*1.1);
  float rays=noise(vec2(u*5.,t*.12))*.6+noise(vec2(u*13.,t*.2+5.))*.4;
  rays=smoothstep(.45,.85,rays)*smoothstep(.05,.8,y)*(1.-smoothstep(.85,1.,y)*.6);
  col+=mix(vec3(.5,.95,.9),lin(glow)*1.25,lowSun*.75)*rays*mix(.22,.45,dark)*(1.-night*mix(.36,.82,dark));
  /* The open water between floor and surface: slow drifting light and shade, so the column never reads flat. */
  float haze=noise(vec2(ax*1.6+t*.03,y*2.4))*.6+noise(vec2(ax*4.-t*.05,y*6.))*.4;
  col*=1.+(haze-.5)*mix(.16,.4,dark)*smoothstep(.3,.55,y)*(1.-smoothstep(.68,.82,y));
  col+=vec3(.4,.85,.85)*glint*mix(.18,.32,dark);
  /* Bubbles: a few rising columns, each a thin bright rim with a highlight, wobbling as they go. */
  float px=1.5/res.y;
  for(int i=0;i<7;i++){
    float fi=float(i),h=h21(vec2(fi,3.7)),h2=h21(vec2(fi,9.1));
    float r=mix(.004,.011,h2);
    float cy=fract(time*mix(.035,.06,h)+h2)*1.15-.08;
    vec2 c=vec2((h-.5)*aspect*.9+sin(time*1.7+fi*2.)*.012,cy);
    float d=length(vec2(ax,y)-c);
    float rim=smoothstep(r+px,r,d)*(.18+.82*smoothstep(r*.55,r,d));
    float spec=smoothstep(r*.45,r*.15,length(vec2(ax,y)-c-vec2(-.35,.35)*r));
    col=mix(col,vec3(.75,1.,1.),clamp(rim*.55+spec*.8,0.,1.));
  }
  col*=1.+.12*wind;
  if(dark>.5){
    /* Dark: richer teal (compressed this far, greys read as mud), the caustics keeping their spark. */
    col=max(mix(vec3(lum(col)),col,1.45),0.)*vec3(.8,1.,1.08);
    /* The clock: moonlit night goes cool and deep; a low sun warms the top of the column. */
    col*=mix(vec3(1.),vec3(.5,.62,1.12),smoothstep(.1,.8,night));
    col*=mix(vec3(1.),mix(vec3(1.),lin(glow)*1.6,.55),lowSun*smoothstep(.2,.95,y));
    gl_FragColor=finish(gradeDark(col,2.));
  }else{
    /* Light: lift toward a pale, luminous aqua; caustics stay as brighter, whiter lines. */
    float cool=smoothstep(.05,.7,night);
    col=mix(col,mix(vec3(.55,.9,.92),vec3(.5,.66,.98),cool),.35+.15*cool);
    col*=mix(vec3(1.),vec3(.78,.86,1.12),cool);
    /* Dawn and dusk: the low sun warms the water toward the surface, so the evening pool differs from noon's. */
    col*=mix(vec3(1.),mix(vec3(1.),lin(glow),.3),lowSun*smoothstep(.15,.9,y));
    gl_FragColor=finish(gradeLight(col,.85));
  }
}`,
};
