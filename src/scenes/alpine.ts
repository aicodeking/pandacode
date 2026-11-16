import type { Scene } from './types';

/** Alpine valley in mist: five mountain ridges receding in atmospheric perspective (slate peaks with snow far off, sage
 * and teal forested ridges nearer, a pine silhouette along the nearest), low fog banks lying in the valleys between the
 * layers, and the sky, rim light and fog following the clock (rose dawn, clear noon, amber dusk, moonlit night with
 * stars). The wind drives the fog faster (via `drift`); the pointer parts the fog where the scene shows. */
export const scene: Scene = {
  id: 'alpine',
  label: 'Alpine',
  fallback: colors => [colors.top, colors.horizon, [.36, .5, .48]],
  fragment: `
/* Ridged noise: sharp peaks, soft valleys; sharp blends ridged (mountains) against smooth (forested hills). */
float ridge(float x,float seed,float sharp){
  float n=0.,a=.5;
  for(int i=0;i<4;i++){float v=noise(vec2(x+seed,seed));n+=a*mix(v,1.-abs(v*2.-1.),sharp);x*=2.07;a*=.5;}
  return n/.9375;
}
/* One fog bank lying at height b: denser below, a soft billowy top that drifts sideways. */
float fogBank(vec2 p,float b,float k,float part,vec2 push){
  vec2 q=p*vec2(1.6,5.)+vec2(drift*(2.2+k*.8)+k*13.,k*4.)+push;
  float n=fbm(q,4);
  float top=b+.05*(n-.35)+.02;
  return smoothstep(top,top-.07,p.y)*smoothstep(.25,.6,n+.2)*(1.-part);
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;float y=uv.y;vec2 p=vec2(uv.x*aspect,y);
  float sv=sun.z,mv=moon.z,day=1.-night;
  vec2 sp=vec2(sun.x*aspect,sun.y+.2),mp=vec2(moon.x*aspect,moon.y+.24);
  float sd=distance(p,sp),md=distance(p,mp);
  float low=1.-smoothstep(.32,.42,sun.y);
  /* Sky: the clock's palette leaned toward a cool sage-teal by day. */
  vec3 hz=mix(hor,vec3(.8,.88,.84),.45*day*(1.-low*.6));
  vec3 mi=mix(mid,vec3(.55,.74,.78),.35*day);
  vec3 sky=mix(hz,mi,smoothstep(.45,.75,y));sky=mix(sky,top,smoothstep(.7,1.,y));
  vec3 col=lin(sky);
  /* Dawn: a rose-peach cast over the whole morning sky (dusk keeps its amber from the palette). */
  float dawn=low*sv*(1.-smoothstep(.3,.5,sun.x));
  /* In dark the dawn band goes amber-orange, so it never reads as dusk's pink. */
  col=mix(col,col*mix(vec3(1.22,.86,.86),vec3(1.34,.92,.6),dark)+lin(mix(vec3(.2,.08,.08),vec3(.22,.12,.03),dark)),dawn*.7);
  col=mix(col,col*vec3(.75,1.,1.)*.9,.5*night);
  if(dark>.5)col=mix(col,col*vec3(.5,.85,1.2),.6*day);
  /* Dark noon: a cooler, higher sky than dusk, with a disc and bloom near the ceiling. */
  float noon=dark*smoothstep(.37,.43,sun.y)*sv;
  col=mix(col,col*vec3(.78,.96,1.2)+vec3(.0,.012,.03),noon);
  vec3 sunC=lin(mix(vec3(1.,.95,.84),glow,.4+.5*low));
  col+=mix(sunC,vec3(1.,.97,.9),noon)*(exp(-sd*mix(6.,3.,low))*(mix(.16,.4,low)+noon*.22)+exp(-sd*20.)*(.25+noon*.5))*sv;
  col=mix(col,mix(sunC*1.25+.15,vec3(2.2),noon),smoothstep(.03,.025,sd)*sv);
  vec2 cell=floor(p*150.),fc=fract(p*150.)-.5;float h=h21(cell);
  float star=step(.986,h)*smoothstep(.22,.0,length(fc+(vec2(h21(cell+3.1),h21(cell+7.7))-.5)*.5))*(.6+.4*sin(time*(1.5+h*3.)+h*40.));
  col=mix(col,vec3(.92,.94,1.),clamp(star*night*smoothstep(.55,.8,y)*1.7,0.,1.));
  col+=vec3(.6,.7,.85)*(exp(-md*9.)*.2+exp(-md*30.)*.15)*mv;
  col=mix(col,vec3(.92,.92,.88),smoothstep(.03,.026,md)*(1.-.97*smoothstep(.032,.02,distance(p,mp+vec2(.013,.007))))*mv);
  /* Light: from the sun's (moon's) side; rim colour warm at dawn and dusk, silver by moonlight. */
  float lx=sign(mix(sun.x,moon.x,step(sv,.02))-.5+1e-3);
  vec3 rimC=mix(mix(lin(lit),sunC,.5*low),vec3(.55,.65,.85),night);
  vec3 haze=lin(mix(hz,vec3(.75,.82,.84),.2));
  vec3 fogC=mix(lin(mix(hz,vec3(.92,.95,.94),.5*day)),lin(vec3(.4,.48,.62)),night*.5)+sunC*.08*sv*low;
  if(dark>.5){haze=mix(haze,haze*vec3(.5,.85,1.2),.6*day);fogC=mix(fogC,fogC*vec3(.55,.85,1.15),.6*day);}
  vec2 v=p-vec2(ptr.x*aspect,ptr.y);
  float g=exp(-dot(v,v)/.03)*ptrAmt,gw=exp(-dot(v,v)/.1)*ptrAmt;
  vec2 push=-(normalize(v+1e-4)*.35+ptrVel*2.5)*g;
  /* High mist drifting across the upper sky: it thins and parts around the pointer, and the light under it brightens. */
  if(y>.4){
    float hm=fbm(vec2(p.x*1.3+drift*1.8,y*3.2-drift*.3)+push*1.4,3);
    float hmA=smoothstep(.4,.68,hm)*smoothstep(.42,.6,y)*(1.-.9*gw)*.65;
    col=mix(col,mix(fogC,lin(mix(lit,vec3(1.),.4))*mix(1.,.45,night),.4*day),hmA);
  }
  col*=1.+gw*mix(.3,.5,dark);
  float px=1.4/res.y;
  /* Five ridges, far to near; each takes the haze by distance, and a fog bank lies in the valley in front of it. */
  for(int i=0;i<5;i++){
    float k=float(i),near=k/4.;
    float sharp=mix(1.,.15,near);
    float base=mix(.47,.19,near),amp=mix(.34,.1,near);
    float x=p.x*mix(1.7,2.6,near)+k*3.7;
    float r=ridge(x,k*7.3,sharp);
    float top=base+amp*r*r;
    /* Slate far off, then teal and sage, the nearest a deep pine green. */
    vec3 rock=mix(lin(vec3(.48,.56,.66)),lin(vec3(.3,.5,.5)),smoothstep(.0,.5,near));
    rock=mix(rock,lin(vec3(.4,.55,.44)),smoothstep(.4,.75,near)*.8);
    rock=mix(rock,lin(vec3(.12,.19,.15)),smoothstep(.7,1.,near));
    rock*=1.-.35*near*smoothstep(.0,.15,top-y);
    float m=smoothstep(top+px,top-px,y);
    /* Pines along the nearest ridge: tiered triangles, a few per cell, varied in height. */
    if(i==4){
      float cw=.026,cx=p.x/cw;
      for(int j=-1;j<=1;j++){
        float c=floor(cx)+float(j),hh=h21(vec2(c,4.2));
        float tx=(c+.5+(hh-.5)*.6)*cw;
        float th=mix(.04,.1,h21(vec2(c,9.1)))*step(.12,hh);
        float rr=base+amp*pow(ridge(tx*2.4+k*3.7,k*7.3,sharp),2.);
        float ty=(y-rr+.008)/th;
        float tier=fract(ty*4.5);
        float hw=cw*.55*(1.-ty)*(.62+.38*tier);
        float tree=step(0.,ty)*step(ty,1.)*smoothstep(hw+px*.7,hw-px*.7,abs(p.x-tx));
        m=max(m,tree*step(y,rr+th));
      }
    }
    if(m<=0.)continue;
    float depth=max(top-y,0.);
    /* Faces: a slope-lit texture on the mountains (light from the light's side), soft gradients on the hills. */
    float e=.004;
    float slope=(ridge(x+e*lx,k*7.3,sharp)-r)/e*.02;
    float tex=fbm(vec2(x*3.,y*mix(7.,4.,near)*3.),3);
    float facing=clamp(.5+slope*2.+(tex-.5)*mix(.9,.3,near),0.,1.);
    vec3 c=rock*mix(.72,1.18,facing);
    /* Snow on the far peaks, broken by the rock texture. */
    float snow=smoothstep(.5,.62,top-base+(tex-.5)*.15+.42-amp)*(1.-near)*smoothstep(.0,.12,amp*r*r-depth*1.2-.06+tex*.08);
    c=mix(c,mix(lin(vec3(.86,.9,.94)),rimC,.25)*mix(.75,1.05,facing),snow*.85);
    /* A rim of light on the crest; the valley floor fades into the fog colour. */
    c+=rimC*exp(-depth*mix(90.,140.,near))*step(y,top)*.25*(.4+.6*facing)*(day*sv+.4*mv);
    c=mix(c,haze,mix(.55,.0,pow(near,.7)));
    c=mix(c,c*vec3(.5,.66,.8)*.7,night*.6);
    c*=1.+gw*.22;
    col=mix(col,c,m);
    /* The fog bank in this valley, in front of this ridge. */
    if(i<4){
      float fb=fogBank(p,base+.02,k,gw*.9,push*(1.+near));
      col=mix(col,fogC,fb*mix(.7,.5,near));
    }
  }
  col=mix(col,col*vec3(1.12,.92,.9),dawn*.5*(1.-dark));
  if(dark>.5){
    col.g-=max(col.r-col.b,0.)*.3*smoothstep(.0,.08,lum(col));col=max(col,0.);
    gl_FragColor=finish(gradeDark(col,1.8));
  }else{
    gl_FragColor=finish(gradeLight(col,.5));
  }
}`,
};
