(() => {
      const a = __PANDACODE_ARGS__;
      try {
        if (a.action === 'read') {
          const clip = (value, limit) => String(value || '').slice(0, limit);
          const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
          const selector = el => {
            if (el.id) return '#' + CSS.escape(el.id);
            const parts=[];
            while(el && el !== document.body && parts.length < 64) {
              const tag=el.localName, siblings=el.parentElement ? [...el.parentElement.children].filter(n=>n.localName===tag) : [];
              parts.unshift(tag + (siblings.length>1 ? ':nth-of-type('+(siblings.indexOf(el)+1)+')' : '')); el=el.parentElement;
            }
            return el === document.body ? 'body > ' + parts.join(' > ') : '';
          };
          const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].filter(visible).slice(0,100)
            .map(el=>({selector:selector(el),tag:el.localName,label:(el.getAttribute('aria-label')||el.textContent||el.getAttribute('placeholder')||'').slice(0,180),type:el.getAttribute('type'),disabled:!!el.disabled})).filter(el=>el.selector && el.selector.length<=2048);
          return JSON.stringify({url:clip(location.href,4096),title:clip(document.title,300),text:(document.body?.innerText||'').slice(0,24000),elements});
        }
        const el=document.querySelector(a.selector);
        if(!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.disabled) throw new Error('Element is unavailable or disabled. Read the page again.');
        if(a.action==='click') {el.click(); return JSON.stringify({clicked:true});}
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || (el instanceof HTMLInputElement && ['file','hidden','submit','button','checkbox','radio','image','reset'].includes(el.type))) throw new Error('Select a text input or textarea.');
        if(el.readOnly) throw new Error('Input is read only.');
        const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set;
        setter.call(el,a.text); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        return JSON.stringify({typed:true});
      } catch(error) {return JSON.stringify({error:String(error.message||error).slice(0,500)});}
    })()
