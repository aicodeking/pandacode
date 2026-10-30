import { call } from './bridge';

type Status = { installed:boolean; sessionReady:boolean; state:string; message:string };
export function mountGoogleConnection(host:HTMLElement, saved:()=>Promise<unknown>):()=>void {
  const status = host.querySelector<HTMLElement>('[data-google-status]')!;
  const feedback = host.querySelector<HTMLElement>('[data-google-feedback]')!;
  const login = host.querySelector<HTMLButtonElement>('[data-google-login]')!;
  const refresh = host.querySelector<HTMLButtonElement>('[data-google-refresh]')!;
  const cancel = host.querySelector<HTMLButtonElement>('[data-google-cancel]')!;
  let disposed=false, busy=false, revision=0, attemptId:string|undefined;
  function message(text:string):void { feedback.textContent=text; feedback.hidden=!text; }
  function setBusy(value:boolean):void { busy=value; login.disabled=value; refresh.disabled=value; cancel.hidden=!value; cancel.disabled=false; }
  async function check():Promise<void> {
    const ticket=++revision;
    status.textContent='Checking Google connection…';
    try {
      const result=await call<Status>('provider_check_connection',{provider:'antigravity'});
      if (disposed || ticket!==revision) return;
      status.textContent=result.sessionReady ? 'Google connection ready. Choose Antigravity in the model selector.' : !result.installed ? 'Install the official Google ACP engine, then refresh.' : result.message;
      login.disabled=busy || !result.installed;
    } catch(error) { if(!disposed && ticket===revision) {status.textContent='Could not check Google connection.';message(String(error));} }
  }
  async function signIn():Promise<void> {
    if(busy) return;
    ++revision; setBusy(true); message('Complete Google sign-in in your browser.');
    const id=crypto.randomUUID(); attemptId=id;
    try { await call('provider_google_login',{attemptId:id}); if(!disposed) {await saved();message('Google sign-in completed.');} }
    catch(error) {if(!disposed) message(String(error));}
    finally {attemptId=undefined;if(!disposed) {setBusy(false);void check();}}
  }
  function stop():void {
    if(attemptId) void call('provider_google_cancel',{attemptId}).catch(error=>{if(!disposed) message(String(error));});
  }
  const click=(event:MouseEvent)=>{ const button=(event.target as Element).closest('button'); if(button===login) void signIn();else if(button===refresh) void check();else if(button===cancel) stop(); };
  const visibility=()=>{if(!host.isConnected || host.closest<HTMLElement>('[hidden]')) stop();};
  const observer=new MutationObserver(visibility);const panel=host.closest('.settings-panel');if(panel) observer.observe(panel,{attributes:true,attributeFilter:['hidden']});
  host.addEventListener('click',click);void check();
  return ()=>{disposed=true;++revision;stop();host.removeEventListener('click',click);observer.disconnect();};
}
