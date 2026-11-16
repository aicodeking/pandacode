import type { Scene } from './types';

/** Deep space: billowing emission gas (magenta, indigo, teal) over a domain-warped flow, cut by dark dust lanes, with a
 * two-layer parallax star field and a few bright stars with soft diffraction glints. The wind swirls the gas faster
 * (via `drift`) and twinkles the stars harder; the pointer is a soft gravitational lens that bends the starlight (and,
 * faintly, the gas) around it. The hue leans a little cooler at night. Light theme: a pale pearl sky with the gas as
 * luminous tints; both graded by the prelude. */
export const scene: Scene = {
  id: 'nebula',
  label: 'Nebula',
  fallback: () => [[.06, .04, .16], [.22, .07, .26], [.05, .16, .2]],
  fragment: `
/* One star layer: a jittered point per cell, sized and tinted by its hash. */
float stars(vec2 q,float density,float tw){
  vec2 c=floor(q),f=fract(q)-.5;float s=h21(c);
  vec2 o=(vec2(h21(c+3.1),h21(c+7.7))-.5)*.6;
  float d=length(f-o);
  float b=step(1.-density,s)*smoothstep(.16,.0,d);
  return b*(.55+.45*sin(time*(1.1+s*4.)*tw+s*60.));
}
void main(){
  vec2 uv=gl_FragCoord.xy/res;vec2 p=vec2(uv.x*aspect,uv.y);
  /* The lens: an image at offset th from the pointer shows the source at th - th*E/(|th|^2+s^2): a soft Einstein ring. */
  vec2 th=p-vec2(ptr.x*aspect,ptr.y);
  float r2=dot(th,th);
  vec2 bend=th*(.012*ptrAmt)/(r2+.006);
  vec2 ps=p-bend;
  float ring=ptrAmt*exp(-abs(sqrt(r2)-.1)*40.)*.5;
  /* The gas: two emission clouds (magenta, teal) and a broad indigo glow, added like light, so where they overlap they
   * mix to lavender and a hot white core; all fold through one slow flow field (two warps that travel apart, so the
   * swirl never winds up) and share one fine billow texture. */
  float t=drift*.55;
  vec2 g=p-bend*.4;
  vec2 w=vec2(fbm(g*1.2+vec2(t,1.7),3),fbm(g*1.2+vec2(5.2,-t*.8),3))-.5;
  /* fbm's spread is narrow: stretch it so the gas has dense cores and clear gaps. */
  float fine=fbm(g*6.5+w*3.+vec2(t*.6,0.),4);
  float bil=.45+1.1*smoothstep(.25,.75,fine);
  float a=fbm(g*1.7+w*1.1+vec2(-t*.3,2.),5),b=fbm(g*2.2-w*1.3+vec2(7.1,t*.25),5);
  float A=smoothstep(.42,.78,a+(fine-.5)*.3),B=smoothstep(.45,.8,b+(fine-.5)*.3);
  float C=smoothstep(.25,.75,fbm(g*.8+w*.5+vec2(3.3,-t*.1),3));
  /* Bright filaments: thin ridges along the clouds' folds. */
  float fil=pow(1.-abs(fine-.5)*2.,10.)*max(A,B)*.8;
  /* Dust lanes: a ridged band of absorption winding across the frame, plus dark knots in the clouds. */
  float lane=1.-abs(fbm(g*1.3+w*1.6+vec2(9.3,-t*.15),4)*2.-1.);
  float dust=clamp(smoothstep(.86,.98,lane)*.85+smoothstep(.62,.72,fine)*.35*A,0.,.92);
  float cool=night*.12;
  vec3 indigo=vec3(.18,.1,.62),magenta=mix(vec3(1.,.14,.55),vec3(.85,.16,.85),cool),teal=vec3(.04,.82,.78);
  vec3 gas=magenta*A*A*bil+teal*B*B*bil*.9+indigo*C*.32+(magenta+teal)*fil*.5;
  /* Where the clouds overlap, a pale hot core. */
  gas+=vec3(1.,.9,.98)*A*B*bil*.45;
  float hue=B/(A+B+1e-3);
  gas*=1.+.55*wind;
  /* Stars: two parallax layers drifting at different speeds, the near one brighter; hidden behind dust. */
  float tw=1.+wind*1.8;
  float s1=stars(ps*95.+vec2(drift*2.,0.),.03,tw)*.5;
  float s2=stars(ps*42.+vec2(drift*5.,7.),.025,tw)*1.1;
  /* A few bright stars with four-point glints. */
  vec2 bc=floor(ps*5.),bf=fract(ps*5.)-.5;float bs=h21(bc+19.);
  vec2 bo=(vec2(h21(bc+2.3),h21(bc+5.9))-.5)*.3;vec2 bd=(bf-bo)/5.;
  vec2 edge=1.-smoothstep(.3,.5,abs(bf));
  float on=step(.8,bs);
  float tw2=.75+.25*sin(time*(.8+bs*2.)*tw+bs*30.);
  float core=exp(-dot(bd,bd)*9e4);
  float glint=(exp(-abs(bd.x)*300.)*exp(-abs(bd.y)*40.)*edge.y+exp(-abs(bd.y)*300.)*exp(-abs(bd.x)*40.)*edge.x)*.5;
  float big=on*(core*1.4+exp(-length(bd)*60.)*.25+glint)*tw2;
  vec3 starC=mix(vec3(.75,.85,1.),vec3(1.,.85,.75),h21(bc+1.));
  float starL=(s1+s2)*(1.-dust*.9)+big*(1.-dust*.6);
  if(dark>.5){
    vec3 col=mix(lin(vec3(.02,.015,.05)),lin(vec3(.04,.02,.08)),uv.y);
    col+=gas*(1.-dust);
    col+=starC*starL*.9;
    col+=vec3(.7,.6,1.)*ring*.08;
    gl_FragColor=finish(gradeDark(col,1.9));
  }else{
    /* Light: pearl-white space, the gas as clear rose/aqua tints, the dust a soft lilac shade. */
    vec3 col=mix(lin(vec3(.93,.92,.98)),lin(vec3(.86,.85,.96)),uv.y);
    /* The lens gathers the gas: tints deepen around the pointer, over a soft lilac well. */
    float well=exp(-r2/.05)*ptrAmt;
    col*=mix(vec3(1.),vec3(.82,.8,.98),well*.6);
    float A=1.-exp(-lum(gas)*8.*(1.+well*2.));
    vec3 tint=gas/max(max(gas.r,gas.g),max(gas.b,1e-3));
    col=mix(col,mix(tint,vec3(1.),.15),A*.9);
    col=mix(col,col*vec3(.78,.74,.9),dust*.45);
    col=mix(col,vec3(1.),clamp(starL,0.,1.)*.6+ring*.1);
    gl_FragColor=finish(gradeLight(col,1.));
  }
}`,
};
