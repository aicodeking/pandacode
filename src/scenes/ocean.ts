import type { Scene } from './types';

/** Open sea: a clock-coloured sky over a calm sea of long swells seen in perspective, with a glitter path under the sun
 * (or the moon at night), thin stratus and soft mist on the horizon. The wind raises the swell and quickens the chop
 * (via `drift`), so the glitter dances, and hurries the high veil and stratus; the pointer drops soft rings that spread
 * from it where the sea shows, thins the sky's veil around it, and that brighter sky reflects in the water below. */
export const scene: Scene = {
  id: 'ocean',
  label: 'Ocean',
  fallback: colors => [colors.top, colors.horizon, [.1, .36, .42]],
  fragment: `
const float H=.4,F=1.25;
/* The sky by screen height above the horizon (e), in linear light. */
vec3 skyAt(float e){
  vec3 c=mix(hor,mid,smoothstep(.0,.3,e));c=mix(c,top,smoothstep(.25,.62,e));
  c=lin(c);
  if(dark>.5)c=mix(c,c*vec3(.42,.72,1.5),.7*(1.-night));
  return c;
}
/* Long swells (analytic height gradient) plus a noise chop whose detail fades with distance. s scales the swell. */
vec2 swell(vec2 q,float s){
  vec2 g=vec2(0.);float t=drift*6.;
  /* Long crests running across the view (rolling toward us), a cross swell, and a shorter sea. */
  vec2 d1=normalize(vec2(.08,1.)),d2=normalize(vec2(-.35,1.)),d3=normalize(vec2(.7,.8));
  float w1=dot(d1,q)*.32-t*.7+noise(q*.05)*2.;
  g+=d1*cos(w1)*.32*.16*(.7+.3*sin(dot(q,vec2(.07,.02))));
  g+=d2*cos(dot(d2,q)*.6-t*1.+1.3)*.6*.06;
  g+=d3*cos(dot(d3,q)*1.3-t*1.5+4.)*1.3*.022;
  return g*s;
}
vec2 chop(vec2 q,float fade){
  vec2 g=vec2(0.);float t=drift*7.;
  vec2 a=q*vec2(1.6,2.6)+vec2(t*.35,-t);
  float e=.08,n=noise(a);g+=vec2(noise(a+vec2(e,0.))-n,noise(a+vec2(0.,e))-n)/e*.05*vec2(1.6,2.6);
  vec2 b=R*q*vec2(4.,6.)+vec2(-t*.5,-t*1.7);
  n=noise(b);g+=R*vec2(noise(b+vec2(e,0.))-n,noise(b+vec2(0.,e))-n)/e*.02*vec2(4.,6.)*fade;
  return g;
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;float y=uv.y;vec2 p=vec2(uv.x*aspect,y);
  /* Bodies: the clock's arcs, re-seated over this horizon (sunrise on the water, noon well up). */
  float sy=H+.015+(sun.y-.3)/.14*.24,my=H+.02+(moon.y-.3)/.08*.16;
  vec3 L=normalize(vec3((sun.x-.5)*aspect,sy-H,F)),M=normalize(vec3((moon.x-.5)*aspect,my-H,F));
  float sv=sun.z,mv=moon.z;
  float low=1.-smoothstep(.04,.2,sy-H);
  vec3 sunC=lin(mix(vec3(1.,.95,.84),glow,.35+.5*low));
  vec3 moonC=vec3(.75,.8,.95);
  vec3 col;
  float mistC=0.;
  if(y>=H){
    float e=y-H;
    col=skyAt(e);
    vec2 sp=vec2(sun.x*aspect,sy),mp=vec2(moon.x*aspect,my);
    float sd=distance(p,sp),md=distance(p,mp);
    col+=sunC*(exp(-sd*mix(6.,3.5,low))*mix(.18,.4,low)+exp(-sd*20.)*.3)*sv;
    /* Thin stratus lying along the horizon, catching the light from below. */
    float band=smoothstep(.015,.05,e)*(1.-smoothstep(.14,.3,e));
    float st=fbm(vec2(p.x*1.2+drift*2.,e*30.+3.),3);
    /* The pointer thins the stratus and lifts the sky around it. */
    vec2 v=p-vec2(ptr.x*aspect,ptr.y);float gs=exp(-dot(v,v)/.14)*ptrAmt;
    float sa=smoothstep(.44,.58,st)*band*smoothstep(.2,.5,noise(vec2(p.x*1.6+drift*.5,7.)))*(1.-.8*gs);
    /* A thin high veil riding the wind: it thickens and runs while an agent works, and parts around the pointer. */
    float veil=smoothstep(.34,.72,fbm(vec2(p.x*1.5+drift*9.,e*5.-drift*1.2),3))*smoothstep(.06,.26,e)*(1.-.85*gs);
    vec3 veilC=mix(lin(lit),vec3(lum(lin(lit))),.35)*mix(1.,.55,night);
    if(dark>.5)veilC=mix(veilC,veilC*vec3(.42,.72,1.5),.7*(1.-night));
    col=mix(col,veilC,veil*(.12+.2*wind));
    col*=1.+gs*mix(.3,.65,dark);
    /* Violet-grey bellies with lit tops, so the strips read against a sky of the same warmth. */
    vec3 cloudC=mix(lin(shade)*1.25+.02,lin(lit),.15+.25*low+.45*smoothstep(.55,.75,st));
    col=mix(col,cloudC+sunC*exp(-sd*5.)*.4*sv,sa);
    /* Stars and the moon at night. */
    vec2 cell=floor(p*150.),fc=fract(p*150.)-.5;float h=h21(cell);
    float star=step(.987,h)*smoothstep(.22,.0,length(fc+(vec2(h21(cell+3.1),h21(cell+7.7))-.5)*.5))*(.6+.4*sin(time*(1.5+h*3.)+h*40.));
    col=mix(col,vec3(.9,.93,1.),clamp(star*night*smoothstep(.12,.4,e)*1.6,0.,1.)*(1.-sa));
    col+=moonC*(exp(-md*9.)*.18+exp(-md*30.)*.18)*mv;
    float moonA=smoothstep(.03,.026,md)*(1.-.97*smoothstep(.032,.02,distance(p,mp+vec2(.013,.007))))*mv;
    col=mix(col,vec3(.92,.92,.86),moonA);
    float core=smoothstep(.03,.025,sd)*sv*(1.-sa*.8);
    col=mix(col,sunC*1.3+.2,core);
    mistC=exp(-e*22.)*(1.-.7*gs);
  }else{
    /* The sea: a ray from a camera one unit above the water. */
    vec3 d=normalize(vec3((uv.x-.5)*aspect,y-H,F));
    float t=1./-d.y;vec2 q=d.xz*t;
    float far=1.-exp(-t*.025);
    float s=(1.+1.1*wind)*(1.-far*.85);
    float ring=0.;
    vec2 g=swell(q,s)+chop(q,exp(-t*.06))*(1.+.6*wind)*(1.-far*.9);
    /* The pointer drops soft rings that spread outward from where it is on the water. */
    if(ptrAmt>.001&&ptr.y<H-.004){
      vec3 dp=normalize(vec3((ptr.x-.5)*aspect,ptr.y-H,F));float tp=1./-dp.y;
      vec2 v=(q-dp.xz*tp)/tp;float r=length(v);
      float ph=r*48.-time*4.,env=exp(-r*3.2)*smoothstep(0.,.02,r)*ptrAmt;
      g+=v/max(r,1e-4)*(cos(ph)*48.-3.2*sin(ph))*env*.019/tp*t;
      ring=env;
    }
    vec3 n=normalize(vec3(-g.x,1.,-g.y));
    vec3 r=reflect(d,n);r.y=abs(r.y);
    float fr=.02+.98*pow(1.-max(dot(n,-d),0.),5.);
    vec3 refl=skyAt(r.y*F*.9);
    /* Sea body: deep teal by day, ink blue by night, a turquoise lift where the swell faces us. */
    vec3 deep=mix(lin(vec3(.05,.3,.36)),lin(vec3(.02,.05,.14)),night);
    deep=mix(deep,deep*lin(glow)*1.6,.25*low*sv);
    float face=clamp(dot(n,normalize(vec3(0.,.2,-1.)))*6.,0.,1.);
    deep+=lin(vec3(.1,.55,.55))*face*.08*(1.-night*.8);
    col=mix(deep,refl,fr);
    /* Glitter: the sun's (moon's) image smeared into a path by the chop: a broad sheen and sharp sparkles. */
    float rs=max(dot(r,L),0.),rm=max(dot(r,M),0.);
    float sheen=pow(rs,60.)*.5+pow(rs,900.)*6.;
    col+=sunC*sheen*sv*(1.-far*.5)*(1.+.4*wind+2.5*ring);
    /* Where the pointer stirs the water, the surface catches a little more light. */
    col*=1.+ring*.6;
    /* A pointer over the sky: its brighter patch reflects as a soft column on the water below. */
    float dx=(p.x-ptr.x*aspect)/.26;
    col*=1.+step(H,ptr.y)*ptrAmt*exp(-dx*dx)*exp(-(H-y)*2.5)*mix(.4,.7,dark);
    col+=moonC*(pow(rm,80.)*.25+pow(rm,1200.)*3.)*mv;
    /* Distance haze toward the horizon tone. */
    col=mix(col,skyAt(.0),far*.85);
    mistC=exp(-(H-y)*30.);
  }
  /* Soft sea mist on the horizon, drifting in slow banks. */
  float bank=.6+.4*noise(vec2(p.x*2.+drift*3.,3.));
  vec3 mist=mix(lin(hor),vec3(lum(lin(hor))),.3)*1.05+lin(glow)*.12*sv;
  if(dark>.5)mist=mix(mist,mist*vec3(.42,.72,1.5),.7*(1.-night));
  col=mix(col,mist,mistC*.65*bank);
  if(dark>.5){
    /* A dusk horizon this dark turns wine: fade its colour toward grey near the water. */
    col=mix(col,vec3(lum(col))*vec3(.98,.94,1.06),.9*smoothstep(.05,.3,night)*(1.-night*.6)*exp(-abs(y-H)*2.5));
    /* Dusk's focal point: a faint ember band on the horizon under the set sun, and the first stars high up. */
    float dx=(uv.x-sun.x)*aspect,dusk=smoothstep(.05,.18,night)*(1.-smoothstep(.45,.8,night))*step(.5,sun.x);
    col+=vec3(.95,.42,.14)*dusk*exp(-dx*dx*.8)*exp(-abs(y-H-.012)*(y>H?16.:36.))*.42;
    if(y>.6){
      vec2 cell=floor(p*150.),fc=fract(p*150.)-.5;float h=h21(cell);
      float first=step(.992,h)*smoothstep(.22,.0,length(fc+(vec2(h21(cell+3.1),h21(cell+7.7))-.5)*.5))*(.6+.4*sin(time*(1.5+h*3.)+h*40.));
      col=mix(col,vec3(.9,.93,1.),clamp(first,0.,1.)*smoothstep(.12,.22,night)*(1.-smoothstep(.45,.8,night))*smoothstep(.6,.72,y));
    }
    col.g-=max(col.r-col.b,0.)*.1*smoothstep(.0,.08,lum(col));col=max(col,0.);
    gl_FragColor=finish(gradeDark(col,1.6));
  }else{
    /* Light: a luminous, airy sea; a touch of aqua kept in the water. */
    if(y<H)col=mix(col,col*mix(vec3(.8,1.04,1.04),vec3(.55,1.,.9),night),.5+.4*night);
    gl_FragColor=finish(gradeLight(col,y<H?.9:.6));
  }
}`,
};
