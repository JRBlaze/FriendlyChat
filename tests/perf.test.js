const { launchApp } = require('./helpers/harness');

let app;

async function boot(options) {
  if (app) app.close();
  app = await launchApp(options);
  return app;
}

function timed(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

describe('perf: feed stays bounded', () => {
  it('caps the DOM at the configured message limit', async () => {
    const a = await boot();
    a.click('.skip-btn');
    for (let i = 0; i < 3000; i++) a.api().addMsg('twitch', `user${i % 50}`, `message ${i}`, { messageId: `m${i}` });
    a.flush();

    const rows = a.$$('#feed .msg').length;
    assertEqual(rows, 500, 'feed should hold exactly the configured maximum');
    // The oldest are gone, the newest survive.
    assertIncludes(a.$('#feed').textContent, 'message 2999');
    assertNotIncludes(a.$('#feed').textContent, 'message 100 ');
    assertEqual(a.api().S.msgCount, 3000, 'the counter still reports everything received');
  });

  it('honours a raised limit', async () => {
    const a = await boot({ storage: { friendly_chat_settings_v1: JSON.stringify({ maxMessages: 1200 }) } });
    a.click('.skip-btn');
    for (let i = 0; i < 2000; i++) a.api().addMsg('kick', 'user', `m${i}`, {});
    a.flush();
    assertEqual(a.$$('#feed .msg').length, 1200);
  });

  it('trims immediately when the limit is lowered', async () => {
    const a = await boot();
    a.click('.skip-btn');
    for (let i = 0; i < 600; i++) a.api().addMsg('twitch', 'user', `m${i}`, {});
    a.flush();
    assertEqual(a.$$('#feed .msg').length, 500);
    a.click('#settings-btn');
    a.change('#set-max-messages', '200');
    assertEqual(a.$$('#feed .msg').length, 200);
  });

  it('bounds the message-id dedupe set', async () => {
    const a = await boot();
    a.click('.skip-btn');
    for (let i = 0; i < 6000; i++) a.api().addMsg('twitch', 'user', `m${i}`, { messageId: `id-${i}` });
    a.flush();
    assert(a.api().S.seenMessageIds.size <= 4000, `dedupe set grew to ${a.api().S.seenMessageIds.size}`);
    // The most recent ids are still deduplicated.
    const before = a.api().S.msgCount;
    a.api().addMsg('twitch', 'user', 'dupe', { messageId: 'id-5999' });
    assertEqual(a.api().S.msgCount, before, 'a recent id must still be recognised as a duplicate');
  });

  it('bounds the recent-chatter list used by @ autocomplete', async () => {
    const a = await boot();
    a.click('.skip-btn');
    for (let i = 0; i < 900; i++) a.api().addMsg('twitch', `chatter${i}`, 'hi', {});
    assert(a.api().S.recentChatters.size <= 200, `chatter map grew to ${a.api().S.recentChatters.size}`);
  });
});

describe('perf: throughput', () => {
  it('absorbs a 5000 message burst quickly', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://x/c.png', source: '7TV' } };

    const ms = timed(() => {
      for (let i = 0; i < 5000; i++) {
        a.api().addMsg('twitch', `user${i % 100}`, `hello catJAM number ${i} https://example.com/${i}`, {
          messageId: `burst-${i}`,
        });
      }
      a.api().flushFeed();
    });

    assert(ms < 12000, `5000 messages took ${ms.toFixed(0)}ms, which is too slow`);
    assertEqual(a.$$('#feed .msg').length, 500);
  });

  it('renders a 6000 emote picker without stalling', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const store = {};
    for (let i = 0; i < 6000; i++) store[`emote${i}`] = { url: `https://x/${i}.png`, source: '7TV' };
    a.api().S.thirdPartyEmotes.twitch = store;

    const ms = timed(() => a.click('#emote-btn'));
    assert(ms < 4000, `emote picker took ${ms.toFixed(0)}ms to open`);
    assertEqual(a.$('#emote-count').textContent, '6000');
    // Only a slice is rendered up front; the rest is reachable through search.
    assert(a.$$('#emote-results .emote-grid-item').length <= 250, 'picker should cap what it renders');
    assertIncludes(a.$('#emote-results').textContent, 'more — type to search');

    const searchMs = timed(() => a.type('#emote-search', 'emote4242'));
    assert(searchMs < 1500, `emote search took ${searchMs.toFixed(0)}ms`);
    assertEqual(a.$$('#emote-results .emote-grid-item').length, 1);
  });

  it('filters a full feed quickly', async () => {
    const a = await boot();
    a.click('.skip-btn');
    for (let i = 0; i < 500; i++) a.api().addMsg(i % 2 ? 'twitch' : 'kick', 'user', `m${i}`, {});
    a.flush();
    const ms = timed(() => a.click('#fc-kick'));
    assert(ms < 800, `filtering took ${ms.toFixed(0)}ms`);
    assertEqual(a.$$('#feed > .msg.hide').length, 250);
  });
});

describe('perf: storage stays bounded', () => {
  it('keeps only the most recent kick emote caches', async () => {
    const a = await boot();
    a.click('.skip-btn');
    const S = a.api().S;
    for (let i = 0; i < 20; i++) {
      S.nativeEmotes.kick = { [`emote${i}`]: { url: 'https://x/e.png', source: 'Kick Channel' } };
      a.window.eval(`cacheKickEmotes('channel${i}')`);
    }
    const cache = JSON.parse(a.window.localStorage.getItem('kick_emotes_cache_v2'));
    const channels = Object.keys(cache.channels);
    assert(channels.length <= 8, `kick emote cache holds ${channels.length} channels`);
    assert(cache.channels.channel19, 'the newest channel must be kept');
  });

  it('caps the recent-channel list', async () => {
    const a = await boot();
    a.click('.skip-btn');
    for (let i = 0; i < 30; i++) a.window.eval(`rememberRecentChannel('twitch','chan${i}')`);
    const cache = JSON.parse(a.window.localStorage.getItem('recent_chat_channels_v1'));
    assertEqual(cache.twitch.length, 12);
    assertEqual(cache.twitch[0].name, 'chan29');
  });

  it('survives a localStorage write failure', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.window.eval(`localStorage.setItem = () => { throw new Error('QuotaExceededError'); }`);
    // None of these may throw.
    a.window.eval(`saveKickEmoteCache({ a: 1 })`);
    a.api().saveSettings();
    a.api().addMsg('twitch', 'user', 'still working', {});
    a.flush();
    assertIncludes(a.$('#feed').textContent, 'still working');
  });
});

describe('perf: timers are cleaned up', () => {
  it('stops the youtube poll loop on leave', async () => {
    const a = await boot({
      routes: [
        ['/youtube-resolve', () => ({ videoId: 'dQw4w9WgXcQ' })],
        ['/youtube-chat', () => ({ messages: [], continuation: 'N', pollMs: 1000, ended: false })],
      ],
    });
    a.click('.skip-btn');
    a.type('#ci-youtube', 'somechannel');
    a.click('#jb-youtube');
    await a.tick(4);
    const pollsWhileJoined = a.fetch.callsTo('/youtube-chat').length;
    assert(pollsWhileJoined >= 1, 'expected at least one poll');

    a.click('#jb-youtube');
    await a.tick(6);
    assertEqual(a.fetch.callsTo('/youtube-chat').length, pollsWhileJoined, 'polling must stop after leaving');
    assertEqual(a.api().S.youtube.timer, null);
  });

  it('does not start a second poll loop when rejoining', async () => {
    const a = await boot({
      routes: [
        ['/youtube-resolve', () => ({ videoId: 'dQw4w9WgXcQ' })],
        ['/youtube-chat', () => ({ messages: [], continuation: 'N', pollMs: 1000, ended: false })],
      ],
    });
    a.click('.skip-btn');
    a.type('#ci-youtube', 'somechannel');
    a.click('#jb-youtube');
    await a.tick(3);
    a.click('#jb-youtube');
    a.type('#ci-youtube', 'otherchannel');
    a.click('#jb-youtube');
    await a.tick(4);
    assertEqual(a.api().S.youtube.epoch >= 2, true);
    assertEqual(a.api().S.channels.youtube, 'otherchannel');
  });

  it('clears the kick keepalive interval on leave', async () => {
    const a = await boot();
    a.click('.skip-btn');
    a.fetch.route(url => url.includes('kick.com/api/v1/channels/'), () => ({ id: 9, user_id: 1, chatroom: { id: 5 } }));
    a.fetch.route(url => url.includes('kick.com/api/v2/channels/'), () => ({ data: { messages: [] } }));
    a.fetch.route('/kick-emotes', () => ({ data: [] }));
    a.fetch.route(url => url.includes('7tv.io'), () => ({ emotes: [] }));
    a.type('#ci-kick', 'chan');
    a.click('#jb-kick');
    await a.tick(3);
    const ws = a.ws.byUrl('pusher.com').pop();
    ws.emit(JSON.stringify({ event: 'pusher:connection_established', data: '{}' }));
    await a.tick(1);
    assert(a.api().S.intervals.kick !== null, 'keepalive should be running');
    a.click('#jb-kick');
    assertEqual(a.api().S.intervals.kick, null);
  });
});

process.on('exit', () => { if (app) app.close(); });
