(() => {
  const a = __PANDACODE_ARGS__;
  const clean = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const visible = el => el instanceof Element && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const point = () => {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1) throw new Error('Invalid browser coordinates.');
    return document.elementFromPoint(a.x * innerWidth, a.y * innerHeight);
  };
  const selector = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts=[];
    while(el instanceof Element && el !== document.body && parts.length<32){const tag=el.localName,siblings=el.parentElement?[...el.parentElement.children].filter(node=>node.localName===tag):[];parts.unshift(tag+(siblings.length>1?':nth-of-type('+(siblings.indexOf(el)+1)+')':''));el=el.parentElement;}
    return el===document.body?'body > '+parts.join(' > '):parts.join(' > ');
  };
  const editable = el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el?.isContentEditable;
  const selectable = el => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && ['', 'text', 'search', 'tel', 'url', 'password'].includes(el.type));
  const boundaries = value => {
    if (globalThis.Intl?.Segmenter) { const out=[0]; let offset=0; for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)){offset+=part.segment.length;out.push(offset);} return out; }
    const out=[0]; let offset=0; for(const point of value){offset+=point.length;out.push(offset);} return out;
  };
  const previous = (value,pos) => boundaries(value).filter(offset=>offset<pos).at(-1) ?? 0;
  const next = (value,pos) => boundaries(value).find(offset=>offset>pos) ?? value.length;
  const paired = value => { for(let i=0;i<value.length;i++){const unit=value.charCodeAt(i);if(unit>=0xd800&&unit<=0xdbff){const following=value.charCodeAt(++i);if(!(following>=0xdc00&&following<=0xdfff))return false;}else if(unit>=0xdc00&&unit<=0xdfff)return false;}return true; };
  const replace = (el,text,start,end,inputType='insertText') => {
    const original=el.value, originalStart=el.selectionStart, originalEnd=el.selectionEnd, originalDirection=el.selectionDirection;
    const descriptor=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value');
    const setter=descriptor?.set;
    if(!setter||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>original.length)throw new Error('Invalid remote text selection.');
    const expected=original.slice(0,start)+text+original.slice(end), caret=start+text.length;
    if(!paired(original)||!paired(text)||!paired(expected))throw new Error('Remote text would split a Unicode character.');
    try {
      setter.call(el,expected);
      el.setSelectionRange(caret,caret,'none');
      if(el.value!==expected||!paired(el.value)||el.selectionStart!==caret||el.selectionEnd!==caret)throw new Error('Browser text selection was inconsistent.');
    } catch(error) {
      setter.call(el,original);
      if(originalStart!==null&&originalEnd!==null)el.setSelectionRange(originalStart,originalEnd,originalDirection||'none');
      throw error;
    }
    el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType,data:text||null}));
  };
  try {
    if (a.kind === 'status') return JSON.stringify({url:clean(location.href,4096),title:clean(document.title,300),loading:document.readyState !== 'complete',canGoBack:history.length>1,canGoForward:false});
    if (a.kind === 'tap') { const el=point(); if(!visible(el)) throw new Error('No visible element at that point.'); el.focus?.(); el.click(); return JSON.stringify({ok:true}); }
    if (a.kind === 'scroll') { window.scrollBy({left:a.deltaX,top:a.deltaY,behavior:'auto'}); return JSON.stringify({ok:true}); }
    const el=document.activeElement;
    if (a.kind === 'type') {
      if(!editable(el)) throw new Error('Tap a text field before typing.');
      if(el.isContentEditable) { document.execCommand('insertText',false,a.text); }
      else if(selectable(el)) { const start=el.selectionStart ?? el.value.length, end=el.selectionEnd ?? start; replace(el,a.text,start,end); }
      else if(el instanceof HTMLInputElement && ['email','number'].includes(el.type)) { const next=el.value+a.text; if(el.type==='number' && next && !Number.isFinite(Number(next))) throw new Error('That text is invalid for this number field.'); el.value=next; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:a.text})); }
      else throw new Error('This input type cannot accept remote text.');
      return JSON.stringify({ok:true});
    }
    if (a.kind === 'key') {
      if(a.key==='Tab') { const nodes=[...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')].filter(n=>visible(n)&&!n.disabled&&n.tabIndex>=0); const i=nodes.indexOf(el); nodes[(i+(a.shift?-1:1)+nodes.length)%nodes.length]?.focus(); }
      else if(a.key==='Escape') el?.blur?.();
      else if(a.key==='Enter') { if(el instanceof HTMLTextAreaElement) {const s=el.selectionStart??el.value.length,e=el.selectionEnd??s;replace(el,'\n',s,e,'insertLineBreak');} else if(el?.form) el.form.requestSubmit(); else if(typeof el?.click==='function') el.click(); else throw new Error('Enter has no target.'); }
      else if(editable(el) && !el.isContentEditable && ['Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(a.key)) {
        if(!selectable(el)) throw new Error('This input does not expose a remote text selection.');
        const value=el.value,s=el.selectionStart??0,e=el.selectionEnd??s;
        if(a.key==='Backspace'){const from=s===e?previous(value,s):s;replace(el,'',from,e,'deleteContentBackward');}
        else if(a.key==='Delete'){const to=s===e?next(value,e):e;replace(el,'',s,to,'deleteContentForward');}
        else { let pos=a.shift?e:(a.key==='ArrowLeft'?s:e); if(a.key==='ArrowLeft')pos=previous(value,pos); else if(a.key==='ArrowRight')pos=next(value,pos); else if(a.key==='Home')pos=el instanceof HTMLTextAreaElement?value.lastIndexOf('\n',Math.max(0,pos-1))+1:0; else if(a.key==='End'){const line=value.indexOf('\n',pos);pos=el instanceof HTMLTextAreaElement&&line>=0?line:value.length;} else if(el instanceof HTMLTextAreaElement){const start=value.lastIndexOf('\n',Math.max(0,pos-1))+1,column=pos-start;if(a.key==='ArrowUp'){const priorEnd=Math.max(0,start-1),priorStart=value.lastIndexOf('\n',Math.max(0,priorEnd-1))+1;pos=Math.min(priorStart+column,priorEnd);}else{const nextStart=value.indexOf('\n',pos);pos=nextStart<0?value.length:Math.min(nextStart+1+column,value.indexOf('\n',nextStart+1)<0?value.length:value.indexOf('\n',nextStart+1));}} else throw new Error('That key requires a multiline field.'); el.setSelectionRange(a.shift?s:pos,pos); }
      }
      else { const delta={PageUp:-innerHeight*.8,PageDown:innerHeight*.8,Home:-scrollY,End:document.documentElement.scrollHeight,ArrowUp:-40,ArrowDown:40}[a.key]; if(delta===undefined) throw new Error('That key is unavailable here.'); window.scrollBy(0,delta); }
      return JSON.stringify({ok:true});
    }
    if(a.kind==='pick') { const el=point(); if(!visible(el)) throw new Error('No visible element at that point.'); const r=el.getBoundingClientRect(); return JSON.stringify({url:clean(location.href,4096),title:clean(document.title,300),selector:clean(selector(el),2048),tag:clean(el.localName,80),text:clean(el.innerText||el.textContent,1200),html:clean(el.outerHTML,3000),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}); }
    throw new Error('Unknown browser input.');
  } catch(error) { return JSON.stringify({error:String(error.message||error).slice(0,500)}); }
})()
