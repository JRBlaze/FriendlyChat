// Offline smoke of the real original Electron preload and renderer, including
// responsive emote geometry. Run with Electron, not Node. No platform actions.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const root=process.env.FC_SMOKE_ROOT || path.resolve(__dirname,'..');
const output=process.env.FC_SMOKE_OUTPUT || path.resolve(__dirname,'..','app-smoke.png');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'friendly-chat-smoke-')));
app.commandLine.appendSwitch('disable-background-networking');
app.disableHardwareAcceleration();
global.fetch=async()=>{throw Error('Offline fixture');};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server,window;
app.whenReady().then(async()=> {
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('http://localhost:18591/')&&!details.url.startsWith('data:')}));
  server=require(path.join(root,'server.js')).start({port:18591,twitch:{client_id:'fixture'}});
  if(!server.listening) await new Promise(resolve=>server.once('listening',resolve));
  window=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,preload:path.join(root,'preload.js')}});
  await window.loadURL('http://localhost:18591/friendly-chat.html');
  await window.webContents.executeJavaScript(`
    document.querySelector('.skip-btn').click();
    const stablePaint=document.createElement('style');
    stablePaint.textContent='*{transition:none!important;animation:none!important;}';
    document.head.appendChild(stablePaint);
    const api=window.__friendlyChat, state=api.S;
    state.channels.twitch='stream';state.channels.kick='stream';
    state.auth.twitch=state.auth.kick=true;state.tokens.twitch='fixture';state.tokens.kick='fixture';
    state.nativeEmotes.twitch={};
    for(let i=0;i<12;i++) {
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="'+['#9146ff','#00b86b','#d29516'][i%3]+'"/><text x="16" y="23" text-anchor="middle" fill="white" font-size="21">'+String.fromCharCode(65+i)+'</text></svg>';
      state.nativeEmotes.twitch['emote'+i]={url:'data:image/svg+xml;base64,'+btoa(svg),source:'Twitch Global',owner:i<3?'Streamer':''};
    }
    api.emotePreferences.toggle({platform:'twitch',name:'emote4'});
    api.emotePreferences.remember('twitch',Object.keys(state.nativeEmotes.twitch).join(' '),api.allEmoteEntries());
    api.renderQuickEmotes();refreshTargets();
    api.addMsg('twitch','Viewer','hello emote1',{messageId:'fixture1',color:'#a970ff'});
    api.addMsg('kick','KickViewer','The original merged feed is still here',{messageId:'fixture2',color:'#20bb64'});
    for(const text of ['Connected to Twitch: stream','Loaded 201 cached Kick emotes','Loaded 45 third-party emotes (7TV/BTTV/FFZ)']) {
      if(api.addSys(text) !== null) throw Error('Diagnostic entered the feed');
    }
    api.addEvent('twitch','Viewer resubscribed (12 months).',{body:'Happy to be here! emote1'});
    api.addEvent('kick','KickViewer gifted 3 subs to the community.');
    api.addSys('Twitch: Your message was not sent. Please wait a moment before trying again.');
    api.flushFeed();
  `);
  for(const width of [1280,800,520]) {
    window.setContentSize(width,800);await pause(150);
    const geometry=await window.webContents.executeJavaScript(`(()=>{
      const bar=document.getElementById('quick-emotes'),bounds=bar.getBoundingClientRect();
      return {bar:{left:bounds.left,right:bounds.right},buttons:[...bar.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top};}),notices:[...document.querySelectorAll('.sys-msg')].map(row=>({width:row.clientWidth,scroll:row.scrollWidth,font:getComputedStyle(row).fontSize,style:getComputedStyle(row).fontStyle})),node:typeof require,extension:typeof chrome?.runtime?.id};
    })()`);
    assert(geometry.buttons.length>=1&&geometry.buttons.length<=8);
    assert(geometry.buttons.every(b=>Math.abs(b.top-geometry.buttons[0].top)<1&&b.left>=geometry.bar.left&&b.right<=geometry.bar.right+1));
    assert.equal(geometry.node,'undefined');assert.equal(geometry.extension,'undefined');
    assert.equal(geometry.notices.length,3);
    assert(geometry.notices.every(row=>row.scroll<=row.width+1&&parseFloat(row.font)>=12&&row.style==='normal'),'notice geometry and readability');
  }
  await window.webContents.executeJavaScript(`document.getElementById('settings-btn').click();document.getElementById('set-quick-emotes').click();`);
  assert(await window.webContents.executeJavaScript(`document.getElementById('quick-emotes').hidden`));
  await window.webContents.executeJavaScript(`document.getElementById('set-quick-emotes').click();document.getElementById('settings-close').click();document.getElementById('emote-btn').click();`);
  const headers=await window.webContents.executeJavaScript(`[...document.querySelectorAll('#emote-results .ac-header')].map(e=>e.textContent)`);
  assert.deepEqual(headers,['Favorites (1)','Streamer · Twitch (3)','Twitch Global (8)']);
  window.setContentSize(1280,800);await pause(150);
  const decoded=await window.webContents.executeJavaScript(`(async()=>{
    const images=[...document.querySelectorAll('#emote-results img')];
    images.forEach(image=>{image.loading='eager';});
    await Promise.all(images.map(image=>image.decode()));
    return images.every(image=>image.naturalWidth>0);
  })()`);
  assert(decoded,'visible picker images must load');
  await window.webContents.executeJavaScript(`document.getElementById('emote-btn').click();applyThemeMode('dark');`);
  await pause(350);
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sys-body')).color`),'rgb(199, 199, 218)');
  fs.writeFileSync(output,(await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`applyThemeMode('light');`);
  await pause(350);
  assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.sys-body')).color`),'rgb(74, 85, 102)');
  fs.writeFileSync(output.replace(/\.png$/, '-light.png'),(await window.webContents.capturePage()).toPNG());
  console.log('PASS: original Electron renderer, favorites/streamer/category order, quick-bar toggle and one-row 1–8 geometry at 1280/800/520px.');
  console.log('Screenshot: '+output);
  console.log('PASS: silent diagnostics, preserved event/feedback rows, readable notice styles, no overflow at all widths, and dark/light screenshots.');
  window.destroy();server.close(()=>app.exit(0));
}).catch(error=>{console.error(error);if(window&&!window.isDestroyed())window.destroy();if(server)server.close();app.exit(1);});
