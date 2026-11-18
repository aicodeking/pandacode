import type { Scene } from './types';

/** Rain on a window: blurred bokeh lights behind fogged glass (a cool, grey-blue city by day; amber, rose and magenta
 * lights by night, the clock's palette tinting the dusk), beads of water that come and go, and larger drops sliding down
 * in fits, leaving trails of droplets and a clear streak through the fog. Each drop refracts a sharper, shifted view of
 * the lights behind it. The wind (an agent running) brings more drops, faster, slanting across the pane (via `drift`,
 * so nothing jumps); the pointer wipes a soft clear streak along its path that fogs back once it rests (the host's
 * presence spring). Light theme: pale misty glass with the lights as soft tints; both graded by the prelude. */
export const scene: Scene = {
  id: 'rain',
  label: 'Rain',
  fallback: colors => {
    const day = colors.top.reduce((sum, v) => sum + v, 0) > 1.2;
    return day ? [[.5, .58, .68], [.42, .5, .6], [.36, .42, .52]] : [[.05, .06, .12], [.1, .07, .14], [.2, .1, .12]];
  },
  fragment: `
/* One bokeh layer: a soft disc per cell (some cells empty), with a faintly brighter rim like a real lens; soft 0..1 is
 * the blur (the fogged glass), k the layer, dens the share of lit cells and far (0..1) how deep it sits. All layers
 * share one low, wide field of city blocks, so lights gather in districts with dark gaps between; far layers are large,
 * soft and strictly inside the blocks, near ones small and scattered. Most discs are small; the few big ones are dim. */
vec3 bokeh(vec2 p,float cell,float soft,float k,float dens,float far){
  /* Rows slide by a hashed amount, so the cells never line up into a grid. */
  vec2 g=p/cell;g.x+=h21(vec2(floor(g.y),k))*.9;
  vec2 c=floor(g),f=g-c-.5;
  float h=h21(c+k*17.),h2=h21(c+k*17.+3.3),h3=h21(c+k*17.+7.1);
  float r=mix(.14,.44,h2*h2);
  vec2 o=(vec2(h,h3)-.5)*(1.-2.*r)*.9;
  float d=length(f-o);
  soft=mix(soft,1.,far*.45);
  float disc=smoothstep(r,r*(1.-mix(.12,.9,soft)),d)*(.8+.2*smoothstep(r*.5,r,d)*(1.-soft));
  /* City lights sit low; a few, dimmer, high up. Each breathes slowly. */
  vec2 at=(c+.5)*cell;
  float blocks=smoothstep(.42,.6,noise(vec2(at.x*2.1,at.y*4.6)+3.7));
  float cluster=mix(mix(.25,1.,blocks),blocks,far);
  float on=step(1.-dens*mix(1.,1.6,far),h)*cluster*mix(1.,.12,smoothstep(.3,.75,p.y))*mix(1.,.55,h2)*(.8+.2*sin(time*(.3+h2)+h3*30.));
  vec3 night1=mix(vec3(1.,.55,.16),vec3(1.,.22,.55),step(.55,h3));
  vec3 nightC=mix(night1,mix(vec3(1.,.82,.5),vec3(.35,.75,.95),step(.85,h2)),step(.7,h2));
  vec3 dayC=mix(vec3(.82,.88,1.),vec3(1.,.93,.8),step(.75,h3));
  return mix(dayC*.7,nightC,max(night,dark*.32))*disc*on;
}
/* A sliding drop's path: wobbling down its column and leaning with the wind. */
float path(float y,float cx,float h,float slant,float w){return cx+sin(y*11.+h*6.)*w*.12+(1.-y)*slant;}
void main(){
  vec2 uv=gl_FragCoord.xy/res;vec2 p=vec2(uv.x*aspect,uv.y);
  float slant=wind*.22;
  /* Beads: a fine grid of droplets that form and evaporate; the wind brings more. */
  vec2 n=vec2(0.);float m=0.;
  for(int k=0;k<2;k++){
    float S=k==0?1./19.:1./37.,fk=float(k);
    vec2 sp=vec2(p.x-(1.-p.y)*slant,p.y)/S+fk*vec2(.37,.61);
    vec2 sc=floor(sp),sf=fract(sp)-.5;
    float sh=h21(sc+1.3+fk*7.),sh2=h21(sc+5.7+fk*7.),sh3=h21(sc+9.2+fk*7.);
    float life=fract(time*.025+drift*.4+sh3);
    float sr=mix(.08,.3,sh2*sh2*sh2)*smoothstep(0.,.08,life)*smoothstep(1.,.75,life)*step(mix(.62,.5,fk)-wind*.25,sh);
    vec2 sv=(sf-(vec2(h21(sc+2.9),sh3)-.5)*(1.-2.*sr))/max(sr,1e-3);
    float sm=sr>0.?smoothstep(1.,.8,length(sv)):0.;
    if(sm>m){n=sv*sm;m=sm;}
  }
  /* Sliding drops: one per column at most, falling in fits (a stick-slip phase), with a trail of droplets above it and
   * a clear streak where it wiped the fog. */
  float W=.075;
  float cxs=p.x-(1.-p.y)*slant;
  float col=floor(cxs/W),ch=h21(vec2(col,4.4)),ch2=h21(vec2(col,8.8));
  float clear=0.;
  if(ch>.5-wind*.32){
    float ph=(time*.045+drift*1.4)*mix(.7,1.3,ch2)+ch*7.;
    ph+=.04*sin(ph*31.)+.03*sin(ph*17.);
    float dy=1.15-fract(ph)*1.35;
    float cx=(col+.5)*W+(ch2-.5)*W*.3;
    float x0=path(dy,cx,ch,slant,W);
    float r=W*mix(.16,.26,ch2);
    vec2 dv=vec2(p.x-x0,(p.y-dy)*.82)/r;
    float dl=length(dv);
    float dm=smoothstep(1.,.85,dl);
    if(dm>m){n=dv*dm;m=dm;}
    float above=p.y-dy;
    float len=.18+ch2*.2;
    if(above>0.&&above<len*1.6){
      float xp=path(p.y,cx,ch,slant,W);
      float ax=abs(p.x-xp);
      clear=smoothstep(r*.9,r*.4,ax)*smoothstep(len*1.6,0.,above);
      /* Trail droplets, smaller and sparser further up. */
      float sp2=.022,ty=fract(above/sp2)-.5,tid=floor(above/sp2);
      float tr=r*.38*(1.-above/len)*step(.35,h21(vec2(col,tid)));
      vec2 tv=vec2(p.x-xp-(h21(vec2(tid,col))-.5)*r*.5,ty*sp2)/max(tr,1e-4);
      float tm=tr>0.?smoothstep(1.,.75,length(tv))*step(above,len):0.;
      if(tm>m){n=tv*tm;m=tm;}
    }
  }
  /* The pointer wipes a soft streak along its recent path (a capsule back along its velocity). */
  vec2 pp=vec2(ptr.x*aspect,ptr.y),pv=ptrVel*vec2(aspect,1.)*3.6;
  vec2 pa=p-pp;float tt=clamp(dot(pa,-pv)/max(dot(pv,pv),1e-5),0.,1.);
  float wd=length(pa+pv*tt),wipe=smoothstep(.17,.07,wd)*ptrAmt;
  /* The water the wipe pushed aside gathers in a thin bright bead along its edge. */
  float wipeRim=smoothstep(.15,.158,wd)*smoothstep(.168,.158,wd)*ptrAmt*.26;
  /* A hand this close warms the glass: the fog thins in a wide halo around the wipe. */
  float warm=exp(-wd*wd/.24)*ptrAmt;
  clear=max(clear,wipe);
  /* Behind the glass: refracted (shifted, flipped) through drops, sharper in drops and wiped streaks. */
  float sharp=max(m,clear);
  vec2 bp=p-n*.035;
  float soft=mix(.95,.12,sharp);
  vec3 sky=mix(mix(lin(vec3(.52,.6,.7)),lin(vec3(.4,.47,.57)),1.-uv.y),mix(lin(vec3(.03,.035,.08)),lin(vec3(.2,.09,.13)),smoothstep(.75,0.,uv.y)),night);
  sky=mix(sky,lin(mix(hor,mid,uv.y))*mix(.85,.4,night),.22);
  /* A soft skyline far behind the glass: blocky rooftops, blurred by the fog (sharper through the drops). */
  float bx=floor(bp.x*7.+.5*floor(bp.x*3.)),bh=.18+.3*h21(vec2(bx,2.))*h21(vec2(bx,5.));
  float bw=mix(.09,.025,sharp);
  float town=smoothstep(bh+bw,bh-bw,bp.y);
  sky=mix(sky,mix(sky*vec3(.5,.54,.62),lin(vec3(.03,.025,.05)),night),town*.75);
  vec3 lights=bokeh(bp+vec2(.71,.53),.34,soft,2.,.42,1.)*.7+bokeh(bp,.15,soft,0.,.4,.4)+bokeh(bp+vec2(.37,.11),.075,soft,1.,.22,0.)*.75;
  /* Light theme: the lights are soft tints, pulled toward the pale glass so their colour never competes with text. */
  float tame=(1.-dark)*(.45+.25*night);
  lights=mix(lights,lum(lights)*vec3(.9,.94,1.),tame);
  vec3 c=sky+lights*mix(1.,mix(.8,.9,dark),night);
  /* Fog: the pane scatters light, lifting and greying what is behind it, except in the drops and clear streaks. */
  vec3 fogC=mix(lin(vec3(.62,.68,.76)),lin(vec3(.1,.095,.14)),night);
  c=mix(c,fogC+c*.4,mix(.45,mix(.6,.74,night),dark)*(1.-sharp)*(1.-.45*warm));
  /* By day in dark the city still shows through the fog, low and quiet, rather than grey glass. */
  c+=lights*dark*(1.-night)*.55*(1.-sharp);
  /* The wind drives thin streaks of water down the pane, slanting with it. */
  float streak=noise(vec2((uv.x+uv.y*wind*.22)*aspect*110.,uv.y*2.2-time*(1.2+wind*5.)));
  c+=mix(vec3(.5,.55,.62),vec3(.16,.17,.2),dark)*smoothstep(.62,.9,streak)*wind*.3*(1.-clear);
  /* Each drop: a darker refractive rim and a small highlight toward the light. */
  float e=length(n/max(m,1e-3));
  c*=(1.+.2*m)*(1.-mix(.3,.15,night)*smoothstep(.55,1.,e)*m);
  /* At night each drop gathers a little of the city's glow, its lower edge most. */
  c+=mix(vec3(lum(lin(vec3(.2,.15,.2)))),lin(vec3(.2,.15,.2)),dark)*m*night*.35;
  c+=mix(vec3(lum(lin(vec3(.5,.36,.4)))),lin(vec3(.5,.36,.4)),dark)*smoothstep(.6,1.,e)*smoothstep(.2,-.6,n.y/max(m,1e-3))*m*night*.5;
  /* Through the wiped glass the world reads deeper and darker than through the fog; the bead along its edge catches light. */
  c*=1.-wipe*mix(.2,.55,dark);
  c+=mix(vec3(.75,.8,.9),vec3(.5,.4,.36),night*dark)*wipeRim*mix(mix(.25,.6,night),.3,dark);
  /* A light night's fog already sits on the grade's floor, so darkening cannot show there: the wipe opens onto clear blue. */
  c=mix(c,vec3(.34,.46,.8),wipe*night*(1.-dark)*.7);
  c+=mix(vec3(.9,.95,1.),vec3(1.,.85,.7),night*dark)*smoothstep(.5,.0,length(n/max(m,1e-3)-vec2(-.35,.4)))*m*mix(.35,mix(.6,.28,dark),night);
  if(dark>.5){
    gl_FragColor=finish(gradeDark(c,2.));
  }else{
    /* Light: pale misty glass; the lights stay as soft colour. */
    c=mix(c,lin(vec3(.86,.9,.95)),.2*(1.-sharp*.5));
    gl_FragColor=finish(gradeLight(c,.9));
  }
}`,
};
