const { launchApp } = require('./helpers/harness');
let app;
async function boot(options) {
  if(app) app.close();
  app = await launchApp(options);
  app.click('.skip-btn');
  return app;
}
function emote(extra={}) { return {url:'https://cdn.example/emote.png',source:'Twitch Global',...extra}; }
function auth(a) {
  const S=a.api().S;
  S.channels.twitch='stream';S.channels.kick='stream';
  S.auth.twitch=S.auth.kick=true;S.tokens.twitch='t';S.tokens.kick='k';
  S.twitchUserId='1';S.twitchBroadcasterId='2';S.twitchBroadcasterChannel='stream';S.kickBroadcasterId=3;
  a.fetch.route('helix/chat/messages',()=>({data:[{is_sent:true}]}));
  a.fetch.route('/kick-send',()=>({is_sent:true}));
  a.window.eval('refreshTargets()');
  return S;
}
function timers(a) {
  const timeouts=new Map(), intervals=new Map();let id=50000;
  const oldTimeout=a.window.setTimeout, oldClear=a.window.clearTimeout,oldClearInterval=a.window.clearInterval;
  a.window.setTimeout=(fn,delay,...args)=> {
    if(delay<500) return oldTimeout(fn,delay,...args);
    const key=++id;timeouts.set(key,{fn,delay});return key;
  };
  a.window.clearTimeout=key=>timeouts.delete(key)||oldClear(key);
  a.window.setInterval=(fn,delay)=>{const key=++id;intervals.set(key,{fn,delay});return key;};
  a.window.clearInterval=key=>intervals.delete(key)||oldClearInterval(key);
  return {timeouts,intervals,fire(delay){const found=[...timeouts].find(([,v])=>v.delay===delay);assert(found,'missing timer '+delay);timeouts.delete(found[0]);return found[1].fn();}};
}
function kick(a,data={id:90,user_id:3,chatroom:{id:777}}) {
  a.fetch.route('kick.com/api/v1/channels/',()=>data);
  a.fetch.route('/kick-emotes',()=>({data:[]}));
  a.fetch.route('7tv.io',()=>({emotes:[]}));
  a.fetch.route('kick.com/api/v2/channels/',()=>({messages:[]}));
}

describe('app improvements: original interface and emote controls',()=> {
  it('keeps identical Twitch/Kick emote names distinct and previews the actual selected image',async()=> {
    const a=await boot(),S=auth(a);
    S.nativeEmotes.twitch={Same:emote({url:'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0'})};
    S.nativeEmotes.kick={Same:emote({url:'https://files.kick.com/emotes/15/fullsize',source:'Kick Global'})};
    a.api().emotePreferences.toggle({platform:'twitch',name:'Same'});a.api().emotePreferences.toggle({platform:'kick',name:'Same'});
    a.click('#emote-btn');assertEqual(a.$$('#emote-results img').length,2);
    a.window.eval(`showEmotePeek(document.querySelector('#emote-results img[data-platform="kick"]'))`);
    assertIncludes(a.$('#emote-peek-img').src,'files.kick.com/emotes/15');assertEqual(a.$('#emote-peek-from').textContent,'Kick Global');
    a.api().emotePreferences.remember('kick','Same',a.api().allEmoteEntries());a.api().renderQuickEmotes();
    const clock=timers(a),image=a.$('#quick-emotes img');image.dispatchEvent(new a.window.MouseEvent('mouseover',{bubbles:true}));clock.fire(600);
    assertIncludes(a.$('#emote-peek-img').src,'files.kick.com/emotes/15');
    const fallback=a.document.createElement('img');fallback.alt='Same';fallback.dataset.chatSrc='https://files.kick.com/emotes/77/fullsize';
    a.window.fallbackImage=fallback;a.window.eval('showEmotePeek(fallbackImage)');assertIncludes(a.$('#emote-peek-img').src,'emotes/77');
    delete fallback.dataset.chatSrc;a.window.eval('showEmotePeek(fallbackImage)');assertIncludes(a.$('#emote-peek-img').src,'emoticons/v2/25');
    fallback.alt='Unknown';fallback.src='https://cdn.example/unknown.png';a.window.eval('showEmotePeek(fallbackImage)');assert(a.$('#emote-peek-from').classList.contains('hidden'));
    fallback.removeAttribute('src');a.window.eval('showEmotePeek(fallbackImage)');
  });
  it('keeps the original channels, composer and YouTube panel with no extension workspace',async()=> {
    const a=await boot();
    for(const id of ['ci-twitch','ci-kick','ci-youtube','send-input','youtube-chat']) assert(a.$('#'+id));
    assertEqual(a.$('script[src]').getAttribute('src'),'app-features.js');
    assertEqual(a.window.chrome,undefined);
    assertEqual(a.consoleErrors.length,0);
  });
  it('orders favorites before streamer groups and categories, persists stars, and searches in place',async()=> {
    const a=await boot(),S=a.api().S;
    S.nativeEmotes.twitch={Z:emote({owner:'Zed'}),A:emote({owner:'Amy'}),G:emote()};
    S.nativeEmotes.kick={K:emote({source:'Kick Emoji'}),hidden:emote({selectable:false})};
    a.click('#emote-btn');
    assertEqual(a.$$('#emote-results .ac-header').map(e=>e.textContent),['Amy · Twitch (1)','Zed · Twitch (1)','Kick Emoji (1)','Twitch Global (1)']);
    a.click('[data-favorite="2"]');
    assertEqual(a.$('#emote-results .ac-header').textContent,'Favorites (1)');
    assertEqual(a.$$('#emote-results .emote-grid-item').length,4);
    assertEqual(a.$('#autocomplete-popup').dataset.mode,'browse');
    const saved=a.window.localStorage.getItem('friendly_chat_emote_favorites_v1');
    assertEqual(JSON.parse(saved),['twitch:G']);
    a.type('#emote-search','z');assertEqual(a.$$('#emote-results .emote-grid-item').length,1);
    a.type('#emote-search','<missing>');assertIncludes(a.$('#emote-results').textContent,'No emotes match');
    a.type('#emote-search','');a.click('[data-favorite="2"]');
    assertEqual(a.api().emotePreferences.favorites.length,0);
    const b=await boot({storage:{friendly_chat_emote_favorites_v1:saved}});
    assertEqual(b.api().emotePreferences.favorites,['twitch:G']);
  });
  it('saves the quick-bar toggle, caps one row at eight, and inserts at the selected text',async()=> {
    const a=await boot(),S=auth(a);
    const records={};for(let i=0;i<12;i++) records['e'+i]=emote();
    S.nativeEmotes.twitch=records;
    a.api().emotePreferences.remember('twitch',Object.keys(records).join(' '),a.api().allEmoteEntries());
    Object.defineProperty(a.$('#quick-emotes'),'clientWidth',{configurable:true,value:1000});
    a.api().renderQuickEmotes();assertEqual(a.$$('#quick-emotes button').length,8);
    a.type('#send-input','hello OLD tail');a.$('#send-input').setSelectionRange(6,9);
    a.click('#quick-emotes button');assertEqual(a.$('#send-input').value,'hello e11  tail');
    Object.defineProperty(a.$('#quick-emotes'),'clientWidth',{configurable:true,value:68});
    a.window.dispatchEvent(new a.window.Event('resize'));assertEqual(a.$$('#quick-emotes button').length,2);
    a.click('#settings-btn');a.change('#set-quick-emotes',false);
    assert(a.$('#quick-emotes').hidden);
    const saved=a.window.localStorage.getItem('friendly_chat_settings_v1');
    const b=await boot({storage:{friendly_chat_settings_v1:saved}});
    assert(b.$('#quick-emotes').hidden);b.click('#settings-btn');assert(!b.$('#set-quick-emotes').checked);
    b.change('#set-quick-emotes',true);assert(!b.$('#quick-emotes').hidden);
  });
  it('refreshes availability without erasing saved names or received rendering',async()=> {
    const a=await boot(),S=auth(a);
    S.nativeEmotes.twitch={locked:emote({selectable:false}),open:emote()};
    a.api().emotePreferences.toggle({platform:'twitch',name:'locked'});
    a.api().emotePreferences.order.push('twitch:locked','twitch:open');
    a.api().renderQuickEmotes();assertEqual(a.$$('#quick-emotes button').length,1);
    a.api().addMsg('twitch','user','locked');a.flush();assertEqual(a.$('#feed img').alt,'locked');
    S.nativeEmotes.twitch.open.selectable=false;
    a.click('#quick-emotes button');assertEqual(a.$('#send-input').value,'');
    a.api().renderQuickEmotes();assertEqual(a.$$('#quick-emotes button').length,0);
    assertEqual(a.api().emotePreferences.favorites,['twitch:locked']);
    a.window.eval("leaveCh('twitch')");assertEqual(a.$$('#quick-emotes button').length,0);
  });
  it('puts silent joined streamers in mention completion and preserves surrounding text',async()=> {
    const a=await boot();a.api().S.channels.twitch='Streamer';
    a.type('#send-input','hi @str tail');a.$('#send-input').setSelectionRange(7,7);a.window.eval('updateAutocomplete()');
    a.key('#send-input','Tab');assertEqual(a.$('#send-input').value,'hi @Streamer  tail');
  });
  it('groups collectible and subscribed-channel Kick emotes correctly without shadowing globals',async()=> {
    const a=await boot();a.api().S.channels.kick='room';
    const data=[{id:'global',emotes:[{id:1,name:'same'}]},{id:7,slug:'Other',emotes:[{id:2,name:'same'},{id:3,name:'sub',subscribers_only:true}]},
      {id:'collectibles',emotes:[{id:4,name:'collected'}]},{id:8,slug:'room',emotes:[{id:5,name:'locked',subscribers_only:true}]}];
    const store=a.api().parseKickEmotePayload(data);
    assertEqual(store.same.id,'1');assertEqual(store.sub.owner,'Other');assert(store.sub.selectable);
    assertEqual(store.collected.source,'Kick Collectibles');assertEqual(store.collected.owner,'');assert(!store.locked.selectable);
    a.api().S.kickSubscribed=true;assert(a.api().parseKickEmotePayload(data).locked.selectable);
  });
  it('refreshes Twitch access from the complete user catalog and resolves streamer names',async()=> {
    const a=await boot(),S=auth(a);
    S.nativeEmotes.twitch={expired:emote({source:'Twitch Sub'}),global:emote()};
    a.fetch.route('helix/chat/emotes/user',()=>({data:[{id:'10',name:'sub',emote_type:'subscriptions',owner_id:'99'}]}));
    a.fetch.route('helix/users?id=',()=>({data:[{id:'99',display_name:'Owner'}]}));
    await a.window.eval('fetchTwitchUserEmotes()');
    assert(!S.nativeEmotes.twitch.expired.selectable);assert(S.nativeEmotes.twitch.global.selectable);
    assert(S.nativeEmotes.twitch.sub.selectable);assertEqual(S.nativeEmotes.twitch.sub.owner,'Owner');
    a.window.eval("disconnectPlatform('twitch')");assert(!S.nativeEmotes.twitch.sub.selectable);
  });
});

describe('app improvements: sending, history, copy and moderation',()=> {
  it('pins/unpins the selected Twitch message through the public API without native windows',async()=> {
    const a=await boot(),S=auth(a);S.canModerate.twitch=true;
    a.fetch.route('helix/chat/pins',()=>a.fetch.json({},204));
    a.api().addMsg('twitch','person','message',{messageId:'id&extra=1',userId:'9'});a.flush();
    for(const label of ['Pin for 5m','Pin until stream ends','Unpin']) {
      a.click('.m-author');a.$$('#user-menu-actions button').find(b=>b.textContent===label).click();await a.tick(3);
    }
    const calls=a.fetch.callsTo('helix/chat/pins');assertEqual(calls.map(c=>c.options.method),['PUT','PUT','DELETE']);
    assertIncludes(calls[0].url,'message_id=id%26extra%3D1&duration_seconds=300');assertNotIncludes(calls[1].url,'duration_seconds');
    assertEqual(calls[0].options.headers.Authorization,'Bearer t');
    a.flush();assertIncludes(a.$('#feed').textContent,'Unpinned message on Twitch');
  });
  it('rejects invalid/unauthorized pin actions and reports refused or failed API calls',async()=> {
    const a=await boot(),S=auth(a);S.canModerate.twitch=true;
    for(const args of ["'bad','id'","'pin',''","'pin','id',20"]) await a.window.eval(`pinTwitchMessage(${args})`);
    assertEqual(a.fetch.callsTo('helix/chat/pins').length,0);
    for(const field of ['auth','canModerate','tokens','twitchBroadcasterId','twitchUserId']) {
      const nested=['auth','canModerate','tokens'].includes(field);const old=nested?S[field].twitch:S[field];
      if(nested) S[field].twitch=null;else S[field]=null;
      await a.window.eval("pinTwitchMessage('pin','id')");
      if(nested) S[field].twitch=old;else S[field]=old;
    }
    assertEqual(a.fetch.callsTo('helix/chat/pins').length,0);
    a.fetch.route('helix/chat/pins',()=>a.fetch.json({message:'refused'},403));await a.window.eval("pinTwitchMessage('pin','id')");
    a.fetch.route('helix/chat/pins',()=>({ok:false,status:429,json:async()=>{throw Error('json');}}));await a.window.eval("pinTwitchMessage('pin','id')");
    a.fetch.route('helix/chat/pins',()=>{throw Error('network');});await a.window.eval("pinTwitchMessage('pin','id')");
    a.flush();assertIncludes(a.$('#feed').textContent,'Twitch pin error: refused');assertIncludes(a.$('#feed').textContent,'Twitch pin failed: network');
  });
  it('encodes Kick native emotes and routes emote-only messages only where available',async()=> {
    const a=await boot(),S=auth(a);
    S.nativeEmotes.kick={KickOnly:emote({source:'Kick Global',id:'10'})};
    a.type('#send-input','KickOnly');a.click('#send-btn');await a.tick(3);
    assertEqual(a.fetch.callsTo('helix/chat/messages').length,0);
    assertEqual(JSON.parse(a.fetch.callsTo('/kick-send')[0].options.body).text,'[emote:10:KickOnly]');
    assertEqual(a.api().emotePreferences.order,['kick:KickOnly']);
    a.type('#send-input','Cheer100 hi');a.click('#send-btn');await a.tick(3);
    assertEqual(a.fetch.callsTo('/kick-send').length,1);assertEqual(a.fetch.callsTo('helix/chat/messages').length,1);
  });
  it('records emotes only after successful sends, and recalls messages without losing a draft',async()=> {
    const a=await boot(),S=auth(a);S.nativeEmotes.twitch={Kappa:emote()};S.target=new Set(['twitch']);
    a.fetch.route('helix/chat/messages',()=>({data:[{is_sent:false,drop_reason:{message:'filtered'}}]}));
    a.type('#send-input','Kappa');a.click('#send-btn');await a.tick(3);
    assertEqual(a.api().emotePreferences.order,[]);assertNotIncludes(a.$('#toast').textContent,'Sent to Twitch');
    a.fetch.route('helix/chat/messages',()=>({data:[{is_sent:true}]}));
    a.type('#send-input','Kappa');a.click('#send-btn');await a.tick(3);
    assertEqual(a.api().emotePreferences.order,['twitch:Kappa']);
    a.type('#send-input','draft');a.key('#send-input','ArrowUp');assertEqual(a.$('#send-input').value,'draft');
    a.$('#send-input').setSelectionRange(0,0);a.key('#send-input','ArrowUp');assertEqual(a.$('#send-input').value,'Kappa');
    a.key('#send-input','ArrowUp');a.key('#send-input','ArrowDown');a.key('#send-input','ArrowDown');assertEqual(a.$('#send-input').value,'draft');
  });
  it('copies raw message text from the app menu and reports clipboard errors',async()=> {
    const a=await boot();let copied='';
    a.window.navigator.clipboard={writeText:async text=>{copied=text;}};
    a.api().addMsg('twitch','person','hello <text>');a.flush();a.click('.m-author');
    a.$$('#user-menu-actions button').find(b=>b.textContent==='Copy message').click();await a.tick();
    assertEqual(copied,'hello <text>');assertEqual(a.$('#toast').textContent,'Message copied');
    a.window.navigator.clipboard.writeText=async()=>{throw Error('blocked');};
    a.click('.m-author');a.$$('#user-menu-actions button').find(b=>b.textContent==='Copy message').click();await a.tick();
    assertEqual(a.$('#toast').textContent,'Could not copy message');
  });
  it('deletes the clicked message instead of a newer one on both platforms',async()=> {
    for(const platform of ['twitch','kick']) {
      const a=await boot(),S=auth(a);S.canModerate[platform]=true;
      a.fetch.route('helix/users',()=>({data:[{id:'9'}]}));
      a.fetch.route('helix/moderation/chat',()=>a.fetch.json({},204));
      a.fetch.route('/kick-mod',()=>({}));
      a.api().addMsg(platform,'person','old',{messageId:'old',userId:'9'});
      a.api().addMsg(platform,'person','new',{messageId:'new',userId:'9'});a.flush();
      a.click('[data-msg-id="old"] .m-author');
      a.$$('#user-menu-actions button').find(b=>b.textContent.includes('Delete this')).click();await a.tick(3);
      const request=a.fetch.callsTo(platform==='twitch'?'helix/moderation/chat':'/kick-mod')[0];
      if(platform==='twitch') assertIncludes(request.url,'message_id=old');
      else assertEqual(JSON.parse(request.options.body).messageId,'old');
      assert(a.$('[data-msg-id="old"]').classList.contains('deleted'));
      assert(!a.$('[data-msg-id="new"]').classList.contains('deleted'));
    }
  });
  it('rejects unknown moderation actions and bad timeouts before making network requests',async()=> {
    const a=await boot(),S=auth(a);S.canModerate.twitch=S.canModerate.kick=true;
    const count=a.fetch.calls.length;
    for(const platform of ['Twitch','Kick']) for(const args of ["'pin','user'","'timeout','user',0","'timeout','user',1209601"]) await a.window.eval(`mod${platform}(${args})`);
    assertEqual(a.fetch.calls.length,count);
  });
});

describe('app improvements: rendering and availability lifecycle',()=> {
  it('renders the incoming Gigantify effect only on the last native Twitch emote',async()=> {
    const a=await boot();
    const result=a.api().renderMessageBody('twitch','Kappa Kappa',{emoteMap:a.api().parseTwitchEmoteMap('25:0-4,6-10'),gigantifiedEmote:true});
    const wrapper=a.document.createElement('div');wrapper.innerHTML=result.html;
    assertEqual(wrapper.querySelectorAll('.emote-gigantified').length,1);
    assert(wrapper.querySelectorAll('img')[1].classList.contains('emote-gigantified'));
    assertNotIncludes(a.api().renderMessageBody('twitch','text',{gigantifiedEmote:true}).html,'emote-gigantified');
  });
  it('uses YouTube image badges only and omits unsafe or missing badge images',async()=> {
    const a=await boot();a.api().S.channels.youtube='room';
    for(const badge of [{type:'moderator',iconUrl:'https://www.gstatic.com/mod.png'},{type:'member'},{iconUrl:'https://evil.test/mod.png'},null,{}]) {
      a.api().renderYouTubeMessage({kind:'message',author:'person',badges:[badge],runs:[{type:'text',text:'hello'}]});
    }
    a.flush();assertEqual(a.$$('.yt-badge-img').length,1);
    assertEqual(a.$$('.yt-badge-label,.msg[data-platform="youtube"] .badge').length,0);
  });
  it('uses ResizeObserver for the quick bar and disconnects it on unload',async()=> {
    let resized,observed=0,disconnected=0;
    const a=await boot({browserSetup(window){window.ResizeObserver=class {constructor(cb){resized=cb;}observe(){observed++;}disconnect(){disconnected++;}};}});
    assertEqual(observed,1);resized();
    a.window.dispatchEvent(new a.window.Event('beforeunload'));assertEqual(disconnected,1);
  });
  it('does not use cached subscription access, or catalog requests from a departed channel',async()=> {
    const a=await boot(),S=a.api().S;
    a.window.localStorage.setItem('kick_emotes_cache_v2',JSON.stringify({global:{ts:Date.now(),emotes:{}},channels:{room:{ts:Date.now(),emotes:{old:emote({source:'Kick Channel',selectable:true})}}}}));
    a.window.eval("loadKickCachedEmotes('room')");assert(!S.nativeEmotes.kick.old.selectable);
    let resolve;a.fetch.route('/kick-emotes',()=>new Promise(r=>resolve=r));S.channels.kick='room';
    const pending=a.window.eval("fetchKickNativeEmotes('room')");a.window.eval("leaveCh('kick')");resolve({data:[{id:1,name:'late'}]});
    await pending;assertEqual(S.nativeEmotes.kick,{});
  });
  it('keeps locked-only sends in the composer and records no false success on Kick',async()=> {
    const a=await boot(),S=auth(a);S.nativeEmotes.kick={locked:emote({selectable:false,source:'Kick Channel',id:'10'})};
    a.type('#send-input','locked');a.click('#send-btn');assertEqual(a.$('#send-input').value,'locked');assertEqual(a.fetch.callsTo('/kick-send').length,0);
    S.nativeEmotes.kick.locked.selectable=true;
    for(const response of [a.fetch.json({error:'denied'},403),{is_sent:false}]) {
      a.fetch.route('/kick-send',()=>response);a.click('#send-btn');await a.tick(3);a.type('#send-input','locked');
    }
    assertEqual(a.api().emotePreferences.order,[]);
  });
  it('inserts quick emotes with suitable spacing and ignores non-buttons and outdated indices',async()=> {
    const a=await boot(),S=auth(a);S.nativeEmotes.twitch={a:emote()};
    a.api().emotePreferences.remember('twitch','a',a.api().allEmoteEntries());a.api().renderQuickEmotes();
    a.click('#quick-emotes');assertEqual(a.$('#send-input').value,'');
    a.type('#send-input','word');a.click('#quick-emotes button');assertEqual(a.$('#send-input').value,'word a ');
    a.type('#send-input','');a.click('#quick-emotes button');assertEqual(a.$('#send-input').value,'a ');
    a.$('#quick-emotes button').dataset.quick='999';a.click('#quick-emotes button');assertEqual(a.$('#send-input').value,'a ');
  });
});

describe('app improvements: token validation',()=> {
  it('validates hourly, preserves sessions during outages, and revokes an expired token',async()=> {
    let hourly;
    const a=await boot({browserSetup(window){const original=window.setInterval;window.setInterval=(fn,delay)=>delay===3600000?(hourly=fn,0):original(fn,delay);}});
    const before=a.fetch.callsTo('/validate').length;hourly();await a.tick();assertEqual(a.fetch.callsTo('/validate').length,before);
    const S=auth(a);a.window.localStorage.setItem('twitch_access_token','t');
    a.fetch.route('/validate',()=>a.fetch.json({},503));hourly();await a.tick(3);assert(S.auth.twitch);
    a.fetch.route('/validate',()=>({client_id:'test'}));a.fetch.route('helix/chat/emotes/user',()=>({data:[]}));
    await a.window.eval("validateTwitchSession('t')");assert(S.auth.twitch);
    a.fetch.route('/validate',()=>a.fetch.json({},401));await a.window.eval("validateTwitchSession('t')");
    assert(!S.auth.twitch);assertEqual(a.window.localStorage.getItem('twitch_access_token'),null);assert(a.ws.last());
  });
  it('rejects a restored expired token, handles malformed validation, and tolerates a network failure',async()=> {
    const a=await boot();
    for(const status of [401,200,503]) {
      a.window.localStorage.setItem('twitch_access_token','old');
      a.fetch.route('/validate',()=>a.fetch.json({},status));await a.window.eval("validateTwitchSession('old',true)");
      if(status===401) assertEqual(a.window.localStorage.getItem('twitch_access_token'),null);
    }
    a.fetch.route('/validate',()=>{throw Error('network');});
    await a.window.eval("validateTwitchSession('old',true)");assert(a.api().S.auth.twitch);
    await a.window.eval("validateTwitchSession('old')");assert(a.api().S.auth.twitch);
    a.window.localStorage.removeItem('twitch_access_token');await a.window.eval("validateTwitchSession('old',true)");
  });
  it('ignores validation answers for a replaced or disconnected session',async()=> {
    const a=await boot(),S=auth(a);let resolve;
    a.fetch.route('/validate',()=>new Promise(r=>resolve=r));
    const pending=a.window.eval("validateTwitchSession('t')");S.tokens.twitch='new';resolve(a.fetch.json({},401));await pending;assertEqual(S.tokens.twitch,'new');
    a.window.localStorage.setItem('twitch_access_token','old');
    const restored=a.window.eval("validateTwitchSession('old',true)");a.window.localStorage.setItem('twitch_access_token','new');resolve(a.fetch.json({},401));await restored;
    assertEqual(a.window.localStorage.getItem('twitch_access_token'),'new');
  });
});

describe('app improvements: late responses and failure paths',()=> {
  it('discards a successful broadcaster lookup that belongs to a departed Twitch connection',async()=> {
    const a=await boot(),S=auth(a);let resolve;
    a.fetch.route('helix/users?login=',()=>new Promise(r=>resolve=r));
    a.window.eval("connectTwitch('stream')");const ws=a.ws.last();ws.open();ws.emit(':tmi.twitch.tv 366 anon #stream :done\r\n');await a.tick();
    a.window.eval("leaveCh('twitch')");resolve({data:[{id:'99',login:'stream'}]});await a.tick(3);
    assertEqual(S.twitchBroadcasterId,null);assertEqual(S.nativeEmotes.twitch,{});
  });
  it('rejects stale Twitch/Kick history and stale socket callbacks',async()=> {
    for(const platform of ['twitch','kick']) {
      const a=await boot(),S=a.api().S,clock=timers(a);kick(a);
      S.channels[platform]='room';a.window.eval(platform==='twitch'?"connectTwitch('room')":"connectKick('room')");await a.tick(3);
      const ws=a.ws.last();ws.open();ws.fail();
      let resolve;a.fetch.route(platform==='twitch'?'recent-messages.robotty.de':'kick.com/api/v2/channels/',()=>new Promise(r=>resolve=r));
      const pending=a.window.eval(platform==='twitch'?"fetchTwitchHistory('room')":"fetchKickHistory(777)");
      a.window.eval(`leaveCh('${platform}')`);ws.open();ws.fail();ws.emit('{}');resolve({messages:[]});await pending;
      a.window.eval(`retryConnection('${platform}','room',0,999)`);
      for(const timer of clock.intervals.values()) timer.fn();
      assertEqual(S.sockets[platform],null);
    }
  });
  it('recovers from failed socket construction, stable drops, and throwing close methods',async()=> {
    const a=await boot(),clock=timers(a),S=a.api().S;S.channels.twitch='room';
    const original=a.window.WebSocket;a.window.WebSocket=class {constructor(){throw Error('constructor');}};
    a.window.eval("connectTwitch('room')");assert([...clock.timeouts.values()].some(t=>t.delay===2000));
    a.window.WebSocket=original;clock.fire(2000);const ws=a.ws.last();ws.open();
    a.window.eval('connections.twitch.connectedAt=Date.now()-31000');ws.close();clock.fire(2000);
    a.ws.last().close=()=>{throw Error('closed');};a.window.eval("stopConnection('twitch')");assertEqual(S.sockets.twitch,null);
  });
  it('covers fresh Kick owner standing, learned emotes and stable reconnects without granting emote access',async()=> {
    const a=await boot(),clock=timers(a),S=a.api().S;kick(a);S.kickUserLogin='room';S.tokens.kick='t';
    a.type('#ci-kick','room');a.click('#jb-kick');await a.tick(3);const ws=a.ws.last();ws.open();
    ws.emit(JSON.stringify({event:'pusher:connection_established',data:'{}'}));assert(S.kickSubscribed);
    ws.emit(JSON.stringify({event:'App\\Events\\ChatMessageEvent',data:JSON.stringify({id:'1',sender:{username:'other'},content:'learned',emotes:[{id:50,name:'learned'}]})}));
    assert(!S.nativeEmotes.kick.learned.selectable);assertEqual(a.api().allEmoteEntries().length,0);
    a.window.eval('connections.kick.connectedAt=Date.now()-31000');ws.close();clock.fire(2000);await a.tick(3);assert(a.ws.last()!==ws);
    a.ws.last()._forceClose=true;a.ws.last().close();assertEqual(S.sockets.kick,null);
  });
  it('handles Pusher errors, invalid descriptors, and departed negotiation requests safely',async()=> {
    for(const mode of ['retired-again','other-error','refused','missing','invalid','late']) {
      const a=await boot(),clock=timers(a);kick(a);a.api().S.channels.kick='room';
      if(mode==='retired-again'||mode==='other-error') {
        a.window.eval("connectKick('room')");await a.tick(3);const ws=a.ws.last();ws.open();
        if(mode==='retired-again') a.window.eval('connections.kick.realtime=true');
        ws.emit(JSON.stringify({event:'pusher:error',data:JSON.stringify({code:mode==='other-error'?4002:4001})}));assertEqual(ws.readyState,3);
      } else {
        a.window.eval('connections.kick.realtime=true');let resolve;
        a.fetch.route('/kick-connection',()=>mode==='late'?new Promise(r=>resolve=r):mode==='refused'?a.fetch.json({},503):{url:mode==='invalid'?'wss://evil.test':'',...(mode==='missing'?{url:undefined}:{})});
        a.window.eval("connectKick('room')");await a.tick(3);
        if(mode==='late') {a.window.eval("leaveCh('kick')");resolve({url:'wss://ws-us2.pusher.com/app/key?protocol=7&client=js&version=7.4.0&flash=false'});await a.tick(3);}
        assertEqual(a.api().S.sockets.kick,null);
      }
      assert(clock.timeouts);
    }
  });
  it('discards rejected channel lookups and broadcaster lookups after leaving',async()=> {
    for(const platform of ['kick','twitch']) {
      const a=await boot(),S=auth(a);let reject;
      a.fetch.route(platform==='kick'?'kick.com/api/v1/channels/':'helix/users?login=',()=>new Promise((r,j)=>reject=j));
      a.window.eval(platform==='kick'?"connectKick('stream')":"connectTwitch('stream')");await a.tick(3);
      if(platform==='twitch') {a.ws.last().open();a.ws.last().emit(':tmi.twitch.tv 366 anon #stream :done\r\n');await a.tick();}
      a.window.eval(`leaveCh('${platform}')`);reject(Error('late'));await a.tick(3);assertEqual(S.sockets[platform],null);
    }
    const a=await boot();auth(a);a.fetch.route('helix/users?login=',()=>{throw Error('outage');});
    a.window.eval("connectTwitch('stream')");a.ws.last().open();a.ws.last().emit(':tmi.twitch.tv 366 anon #stream :done\r\n');await a.tick(3);
  });
  it('ignores stale emote catalogs and preserves access during a failed Twitch refresh',async()=> {
    const a=await boot(),S=auth(a);
    S.nativeEmotes.twitch={existing:emote({selectable:true}),owned:emote({ownerId:'99'})};
    a.fetch.route('helix/chat/emotes/user',()=>a.fetch.json({},503));await a.window.eval('fetchTwitchUserEmotes()');assert(S.nativeEmotes.twitch.existing.selectable);
    let resolve;a.fetch.route('helix/chat/emotes/user',()=>new Promise(r=>resolve=r));
    const user=a.window.eval('fetchTwitchUserEmotes()');S.tokens.twitch='new';resolve({data:[]});await user;
    S.tokens.twitch='t';a.fetch.route('helix/chat/emotes/set',()=>new Promise(r=>resolve=r));
    const sets=a.window.eval("fetchTwitchEmoteSets(['1'])");S.tokens.twitch='new';resolve({data:[]});await sets;
    S.tokens.twitch='t';a.fetch.route('helix/chat/emotes?broadcaster_id=',()=>new Promise(r=>resolve=r));
    const channel=a.window.eval("fetchTwitchChannelEmotes('2')");S.channels.twitch='different';resolve({data:[]});await channel;
    a.fetch.route('helix/chat/emotes/global',()=>({}));await a.window.eval('fetchTwitchGlobalEmotes()');
    a.fetch.route('helix/chat/emotes/set',()=>({}));await a.window.eval("fetchTwitchEmoteSets(['1'])");
    a.fetch.route('helix/chat/emotes?broadcaster_id=',()=>({}));await a.window.eval("fetchTwitchChannelEmotes('2')");
    a.fetch.route('helix/chat/emotes/user',()=>({}));await a.window.eval('fetchTwitchUserEmotes()');
    a.window.eval("addTwitchEmote({id:'9',name:'mine',emote_type:'subscriptions',owner_id:'2'})");assertEqual(S.nativeEmotes.twitch.mine.owner,'different');
  });
  it('handles missing/refused owner lookups and uses a streamer login when no display name exists',async()=> {
    const a=await boot(),S=auth(a);S.nativeEmotes.twitch={owned:emote({ownerId:'99'})};
    a.fetch.route('helix/users?id=',()=>a.fetch.json({},503));await a.window.eval("resolveTwitchEmoteOwners('t','client')");
    a.fetch.route('helix/users?id=',()=>({}));await a.window.eval("resolveTwitchEmoteOwners('t','client')");
    a.fetch.route('helix/users?id=',()=>({data:[{id:'99',login:'owner'}]}));await a.window.eval("resolveTwitchEmoteOwners('t','client')");assertEqual(S.nativeEmotes.twitch.owned.owner,'owner');
  });
  it('drops departed third-party catalogs and groups full HTTPS FFZ room images',async()=> {
    const a=await boot(),S=a.api().S;S.channels.twitch='room';let resolve;
    a.fetch.route('7tv.io/v3/emote-sets/global',()=>new Promise(r=>resolve=r));
    const pending=a.window.eval("fetchThirdPartyEmotes('twitch','room','1')");a.window.eval("leaveCh('twitch')");resolve({emotes:[]});await pending;assertEqual(S.thirdPartyEmotes.twitch,{});
    a.fetch.route('7tv.io/v3/emote-sets/global',()=>({emotes:[]}));
    a.fetch.route('frankerfacez.com/v1/room/',()=>({sets:{1:{emoticons:[{name:'ffz',urls:{2:'https://cdn.frankerfacez.com/ffz'}}]}}}));
    await a.window.eval("fetchThirdPartyEmotes('twitch','room','1')");assertEqual(S.thirdPartyEmotes.twitch.ffz.owner,'room');
  });
  it('keeps generic emotes selectable, strips personal Kick access on disconnect, and covers copy/details/delete fallbacks',async()=> {
    const a=await boot(),S=auth(a);S.canModerate.twitch=S.canModerate.kick=true;
    S.nativeEmotes.kick={global:emote({source:'Kick Global'}),emoji:emote({source:'Kick Emoji'}),sub:emote({source:'Kick Channel',subscribersOnly:true}),free:emote({source:'Kick Channel',channel:true}),other:emote({source:'Kick Collectibles'})};
    a.window.eval("disconnectPlatform('kick')");assert(!S.nativeEmotes.kick.sub.selectable);assert(S.nativeEmotes.kick.global.selectable);
    S.nativeEmotes.twitch={generic:{url:'https://cdn.example/generic'}};assertEqual(a.api().allEmoteEntries()[0].source,'twitch');
    auth(a);S.canModerate.kick=true;a.fetch.route('helix/users',()=>({data:[{id:'9'}]}));a.fetch.route('helix/moderation/chat',()=>a.fetch.json({},204));a.fetch.route('/kick-mod',()=>({}));
    a.window.navigator.clipboard={writeText:async()=>{}};
    for(const platform of ['twitch','kick']) {
      a.api().addMsg(platform,'person','text',{messageId:platform});a.flush();
      a.click(`[data-msg-id="${platform}"] .m-author`);a.$$('#user-menu-actions button').find(b=>b.textContent.includes('User details')).click();await a.tick();
      a.$(`[data-msg-id="${platform}"]`).dataset.rawText='';a.click(`[data-msg-id="${platform}"] .m-author`);a.$$('#user-menu-actions button').find(b=>b.textContent==='Copy message').click();await a.tick();
      await a.window.eval(`mod${platform==='twitch'?'Twitch':'Kick'}('delete','person')`);
    }
    a.api().renderYouTubeMessage({author:'owner',badges:{}});S.channels.youtube='room';
    a.api().renderYouTubeMessage({author:'owner',badges:{}});a.api().renderYouTubeMessage({author:'owner',badges:[{type:'owner'}]});
    a.window.requestAnimationFrame=a.window.cancelAnimationFrame=undefined;a.api().addMsg('twitch','user','queued');
    a.window.dispatchEvent(new a.window.Event('beforeunload'));
  });
});

describe('app improvements: connection recovery',()=> {
  it('migrates a retired Kick Pusher app and uses the channel ID rather than the chatroom ID',async()=> {
    const a=await boot();kick(a);
    a.fetch.route('/kick-connection',()=>({url:'wss://ws-us2.pusher.com/app/NEWKEY?protocol=7&client=js&version=7.4.0&flash=false'}));
    a.type('#ci-kick','room');a.click('#jb-kick');await a.tick(3);
    const old=a.ws.last();old.open();old.emit(JSON.stringify({event:'pusher:error',data:JSON.stringify({code:4001})}));await a.tick(4);
    const ws=a.ws.last();assertIncludes(ws.url,'NEWKEY');
    assertEqual(JSON.parse(a.fetch.callsTo('/kick-connection')[0].options.body).channelId,90);
    ws.open();ws.emit(JSON.stringify({event:'pusher:connection_established',data:'{}'}));
    assertIncludes(ws.sent.join(''),'chatrooms.777.v2');assertIncludes(ws.sent.join(''),'channel.90');
    a.flush();assertIncludes(a.$('#feed').textContent,'Connected to Kick: room');
  });
  it('discards a late Kick lookup after leaving, even when no socket exists yet',async()=> {
    const a=await boot();let resolve;kick(a);
    a.fetch.route('kick.com/api/v1/channels/',()=>new Promise(r=>resolve=r));
    a.type('#ci-kick','room');a.click('#jb-kick');a.click('#jb-kick');
    resolve({id:90,chatroom:{id:777}});await a.tick(4);
    assertEqual(a.ws.instances.length,0);assertEqual(a.api().S.channels.kick,null);
  });
  it('retries failed channel lookups and resumes after exhausting a bounded burst',async()=> {
    const a=await boot(),clock=timers(a);kick(a);
    a.fetch.route('kick.com/api/v1/channels/',()=>a.fetch.json({},503));
    a.api().S.channels.kick='room';a.window.eval("connectKick('room',10)");await a.tick(3);
    assert([...clock.timeouts.values()].some(t=>t.delay===300000));
    kick(a);clock.fire(300000);await a.tick(3);assert(a.ws.last());
    const stale=[...clock.timeouts.values()];a.window.eval("leaveCh('kick')");
    for(const timer of stale) timer.fn();await a.tick();assertEqual(a.api().S.sockets.kick,null);
  });
  it('keeps retry bursts bounded across rapid successful handshakes and cancels stale callbacks',async()=> {
    const a=await boot(),clock=timers(a);a.api().S.channels.twitch='room';
    a.window.eval("connectTwitch('room',10)");const ws=a.ws.last();ws.open();ws.emit(':tmi.twitch.tv 366 anon #room :done\r\n');ws.close();
    const cooldown=[...clock.timeouts.values()].find(t=>t.delay===300000);assert(cooldown);
    a.window.eval("leaveCh('twitch')");a.api().S.channels.twitch='room';a.window.eval("connectTwitch('room')");
    const current=a.ws.last();cooldown.fn();assertEqual(a.ws.last(),current);
    ws.emit(':old PRIVMSG #room :old message\r\n');a.flush();assertNotIncludes(a.$('#feed').textContent,'old message');
  });
  it('pings within 25 seconds, requires liveness, and closes dead sockets',async()=> {
    for(const platform of ['kick','twitch']) {
      const a=await boot();kick(a);a.api().S.channels[platform]='room';
      a.window.eval(platform==='kick'?"connectKick('room')":"connectTwitch('room')");await a.tick(3);
      const ws=a.ws.last(),clock=timers(a);ws.open();
      if(platform==='kick') ws.emit(JSON.stringify({event:'pusher:connection_established',data:JSON.stringify({activity_timeout:10})}));
      const interval=[...clock.intervals.values()][0];assert(interval.delay<=25000);
      interval.fn();assertIncludes(ws.sent.join(''),platform==='kick'?'pusher:ping':'PING :friendly-chat');
      const count=clock.timeouts.size;interval.fn();assertEqual(clock.timeouts.size,count);
      ws.emit(platform==='kick'?JSON.stringify({event:'pusher:pong',data:'{}'}):':server PONG server :friendly-chat\r\n');
      assert(![...clock.timeouts.values()].some(t=>t.delay===30000));
      interval.fn();clock.fire(30000);assertEqual(ws.readyState,3);
    }
  });
  it('recovers YouTube polling after a cooldown and stops all pending recovery on unload',async()=> {
    const a=await boot(),clock=timers(a);a.api().S.channels.youtube='room';
    a.fetch.route('/youtube-chat',()=>a.fetch.json({error:'offline'},503));
    a.window.eval("startYouTubePolling('dQw4w9WgXcQ')");await a.tick();
    for(const delay of [2000,4000,8000,16000,30000]) {await clock.fire(delay);await a.tick();}
    assert([...clock.timeouts.values()].some(t=>t.delay===300000));
    a.fetch.route('/youtube-chat',()=>({continuation:'next',pollMs:5000,messages:[]}));
    await clock.fire(300000);await a.tick();assert(a.api().S.youtube.polling);
    a.window.dispatchEvent(new a.window.Event('beforeunload'));assert(!a.api().S.youtube.polling);
  });
});
