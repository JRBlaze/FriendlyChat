const { launchApp } = require('./helpers/harness');

let app;

async function boot(options) {
  if (app) app.close();
  app = await launchApp(options);
  return app;
}

function body(app, index = 0) {
  app.flush();
  return app.$$('#feed .msg .m-body')[index]?.innerHTML || '';
}

describe('render: escaping and links', () => {
  it('escapes HTML in message bodies and author names', async () => {
    const a = await boot();
    const api = a.api();
    api.addMsg('twitch', '<img src=x onerror=alert(1)>', '<script>alert(2)</script> & "quotes"', {});
    a.flush();
    const msg = a.$('#feed .msg');
    // Nothing hostile may become a real node: the payload survives only as text.
    assertEqual(msg.querySelectorAll('img, script, iframe').length, 0);
    assertIncludes(msg.querySelector('.m-body').textContent, '<script>alert(2)</script>');
    assertIncludes(msg.querySelector('.m-body').textContent, '& "quotes"');
    assertEqual(msg.querySelector('.m-author').textContent, '<img src=x onerror=alert(1)>');
  });

  it('does not double-escape ampersands inside links', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'look https://example.com/a?b=1&c=2 ok', {});
    const html = body(a);
    assertIncludes(html, 'href="https://example.com/a?b=1&amp;c=2"');
    assertNotIncludes(html, '&amp;amp;');
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/a?b=1&c=2');
  });

  it('linkifies kick messages without mangling the query string', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'see https://kick.com/x?a=1&b=2', {});
    const html = body(a);
    assertNotIncludes(html, '&amp;amp;');
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://kick.com/x?a=1&b=2');
  });

  it('keeps trailing punctuation out of the link', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'go to https://example.com/page.', {});
    a.flush();
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/page');
    assertIncludes(a.$('#feed .m-body').textContent, 'https://example.com/page.');
  });

  it('does not turn a javascript: string into a link', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'javascript:alert(1)', {});
    assertEqual(a.$$('#feed .chat-link').length, 0);
  });
});

describe('render: twitch emotes', () => {
  it('replaces native emote ranges using codepoint positions', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'Kappa hello', {
      emoteMap: { 0: { id: '25', end: 4 } },
    });
    const html = body(a);
    assertIncludes(html, 'emoticons/v2/25/default/dark');
    assertIncludes(html, 'alt="Kappa"');
    assertIncludes(html, 'hello');
  });

  it('keeps emote positions correct after multi-byte characters', async () => {
    const a = await boot();
    // "😀 Kappa" — Kappa starts at codepoint index 2, byte index 4.
    a.api().addMsg('twitch', 'user', '😀 Kappa', {
      emoteMap: { 2: { id: '25', end: 6 } },
    });
    const html = body(a);
    assertIncludes(html, 'alt="Kappa"');
    assertIncludes(html, '😀');
  });

  it('renders 7TV, BTTV and FFZ emotes from the third-party store', async () => {
    const a = await boot();
    const S = a.api().S;
    S.thirdPartyEmotes.twitch = {
      catJAM: { url: 'https://cdn.7tv.app/catjam.webp', source: '7TV' },
      monkaS: { url: 'https://cdn.betterttv.net/emote/1/2x', source: 'BTTV' },
      ZreknarF: { url: 'https://cdn.frankerfacez.com/2', source: 'FFZ' },
    };
    a.api().addMsg('twitch', 'user', 'catJAM monkaS ZreknarF plain', {});
    const html = body(a);
    assertIncludes(html, 'cdn.7tv.app/catjam.webp');
    assertIncludes(html, 'cdn.betterttv.net/emote/1/2x');
    assertIncludes(html, 'cdn.frankerfacez.com/2');
    assertIncludes(html, 'plain');
    assertEqual(a.$$('#feed .chat-emote').length, 3);
  });

  it('does not replace text inside a link with an emote', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { example: { url: 'https://x/e.png', source: '7TV' } };
    a.api().addMsg('twitch', 'user', 'https://example.com/example', {});
    const html = body(a);
    assertEqual(a.$$('#feed .chat-emote').length, 0);
    assertIncludes(html, 'href="https://example.com/example"');
  });

  it('matches emotes only as whole words', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { pog: { url: 'https://x/pog.png', source: '7TV' } };
    a.api().addMsg('twitch', 'user', 'pogchamp pog', {});
    a.flush();
    assertEqual(a.$$('#feed .chat-emote').length, 1);
    assertIncludes(a.$('#feed .m-body').textContent, 'pogchamp');
  });

  it('handles emote names containing HTML-special characters', async () => {
    const a = await boot();
    a.api().S.thirdPartyEmotes.twitch = { '<3': { url: 'https://x/heart.png', source: 'BTTV' } };
    a.api().addMsg('twitch', 'user', 'love <3 you', {});
    a.flush();
    const img = a.$('#feed .chat-emote');
    assertEqual(img.getAttribute('src'), 'https://x/heart.png');
    assertEqual(img.getAttribute('alt'), '<3');
  });
});

describe('render: kick emotes', () => {
  it('renders inline [emote:id:name] tokens', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'hey [emote:1234:kickHi] there', {});
    const html = body(a);
    assertIncludes(html, 'files.kick.com/emotes/1234/fullsize');
    assertIncludes(html, 'alt="kickHi"');
    assertIncludes(html, 'there');
  });

  it('renders emotes supplied as history metadata', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'wow kickLove', {
      emotes: [{ id: 55, name: 'kickLove' }],
    });
    assertIncludes(body(a), 'files.kick.com/emotes/55/fullsize');
  });

  it('parses kick nested emote-set payloads (global, emoji and channel sets)', async () => {
    const a = await boot();
    const store = a.api().parseKickEmotePayload([
      { id: 'emoji', name: 'Emoji', emotes: [{ id: 1, name: 'smile' }] },
      { id: 'Global', name: 'Global', emotes: [{ id: 2, name: 'kickGlobal' }] },
      { id: 42, user_id: 7, slug: 'streamer', emotes: [{ id: 3, name: 'streamerLove', subscribers_only: true }] },
    ]);
    assertEqual(Object.keys(store).sort(), ['kickGlobal', 'smile', 'streamerLove']);
    assertEqual(store.kickGlobal.source, 'Kick Global');
    assertEqual(store.smile.source, 'Kick Emoji');
    assertEqual(store.streamerLove.source, 'Kick Channel');
    assertEqual(store.streamerLove.url, 'https://files.kick.com/emotes/3/fullsize');
  });

  it('still accepts a flat emote list', async () => {
    const a = await boot();
    const store = a.api().parseKickEmotePayload([{ id: 9, name: 'flatEmote' }]);
    assertEqual(store.flatEmote.url, 'https://files.kick.com/emotes/9/fullsize');
  });

  it('ignores junk payloads instead of throwing', async () => {
    const a = await boot();
    assertEqual(a.api().parseKickEmotePayload(null), {});
    assertEqual(a.api().parseKickEmotePayload({ error: 'blocked' }), {});
    assertEqual(a.api().parseKickEmotePayload([{ emotes: [{ id: 'not-numeric', name: 'x' }] }]), {});
  });
});

describe('render: youtube messages', () => {
  it('renders text, custom emoji and links from run arrays', async () => {
    const a = await boot();
    a.api().addMsg('youtube', 'Viewer', 'hello :_cozy: link', {
      runs: [
        { type: 'text', text: 'hello ' },
        { type: 'emoji', url: 'https://yt3.ggpht.com/cozy.png', alt: ':_cozy:' },
        { type: 'text', text: ' ' },
        { type: 'link', url: 'https://example.com/?a=1&b=2', text: 'https://example.com/?a=1&b=2' },
      ],
    });
    const html = body(a);
    assertIncludes(html, 'yt3.ggpht.com/cozy.png');
    assertIncludes(html, 'youtube-emote');
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/?a=1&b=2');
  });

  it('shows super chat amounts', async () => {
    const a = await boot();
    a.api().addMsg('youtube', 'Spender', 'thanks', { runs: [{ type: 'text', text: 'thanks' }], superChat: '$5.00' });
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'superchat');
    assertEqual(a.$('#feed .superchat-amount').textContent, '$5.00');
  });

  it('escapes a hostile YouTube display name', async () => {
    const a = await boot();
    a.api().addMsg('youtube', `'); alert(1); //`, 'hi', { runs: [{ type: 'text', text: 'hi' }] });
    a.flush();
    const author = a.$('#feed .m-author');
    assertEqual(author.dataset.user, `'); alert(1); //`);
    assertNotIncludes(a.$('#feed .msg').innerHTML, 'alert(1)</span>');
  });
});

describe('render: mentions', () => {
  it('highlights a whole-word mention and not a substring', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hey @bob how are you', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
    assertEqual(a.$('#feed .mention-self').textContent, '@bob');
  });

  it('ignores a name embedded in a longer word', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'bobcat sighting', {});
    a.flush();
    assertNotIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('matches a bare nickname surrounded by punctuation', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'someone', 'hi, bob!', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('never highlights your own messages', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'bob';
    a.api().addMsg('twitch', 'bob', 'talking about bob again', {});
    a.flush();
    assertNotIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('does not corrupt markup when the name also appears in an emote url', async () => {
    const a = await boot();
    a.api().S.twitchUserLogin = 'cdn';
    a.api().S.thirdPartyEmotes.twitch = { catJAM: { url: 'https://cdn.7tv.app/catjam.webp', source: '7TV' } };
    a.api().addMsg('twitch', 'someone', 'catJAM cdn', {});
    a.flush();
    const img = a.$('#feed .chat-emote');
    assertEqual(img.getAttribute('src'), 'https://cdn.7tv.app/catjam.webp');
    assertEqual(a.$('#feed .mention-self').textContent, 'cdn');
  });

  it('uses the extra nicknames from settings', async () => {
    const a = await boot();
    a.api().settings.extraNicknames = 'CoolGuy, other';
    a.api().addMsg('twitch', 'someone', 'yo coolguy', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });

  it('handles regex characters in a nickname without throwing', async () => {
    const a = await boot();
    a.api().settings.extraNicknames = 'a.b(c)';
    a.api().addMsg('twitch', 'someone', 'hello a.b(c) there', {});
    a.flush();
    assertIncludes(a.$('#feed .msg').className, 'mention-highlight');
  });
});

describe('render: system and event rows', () => {
  it('renders system rows with a SYSTEM tag, not as a chat message', async () => {
    const a = await boot();
    a.api().addSys('Connected to Twitch: someone');
    a.flush();
    const row = a.$('#feed .sys-msg');
    assert(row, 'expected a system row');
    assertEqual(row.querySelector('.sys-tag').textContent, 'SYSTEM');
    assertEqual(a.$$('#feed .msg').length, 0, 'system rows must not be chat messages');
    assertEqual(row.querySelector('.m-author'), null);
  });

  it('flags errors so they stand out', async () => {
    const a = await boot();
    a.api().addSys('Kick: could not load channel');
    a.flush();
    assertIncludes(a.$('#feed .sys-msg').className, 'error');
  });

  it('renders platform events as EVENT rows carrying the platform', async () => {
    const a = await boot();
    a.api().addEvent('twitch', 'someone subscribed.');
    a.flush();
    const row = a.$('#feed .sys-msg.event');
    assertEqual(row.dataset.platform, 'twitch');
    assertEqual(row.querySelector('.sys-tag').textContent, 'EVENT');
    assertIncludes(row.textContent, 'someone subscribed.');
  });

  it('escapes system text', async () => {
    const a = await boot();
    a.api().addSys('<script>alert(1)</script>');
    a.flush();
    assertNotIncludes(a.$('#feed .sys-msg').innerHTML, '<script>');
  });
});

describe('render: IRC parsing', () => {
  it('parses tags, prefix, command and trailing parameters', async () => {
    const a = await boot();
    const line = '@badges=moderator/1;display-name=Bob;id=abc :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hello world';
    const parsed = a.api().parseIrcLine(line);
    assertEqual(parsed.command, 'PRIVMSG');
    assertEqual(parsed.params, ['#chan', 'hello world']);
    assertEqual(parsed.tags['display-name'], 'Bob');
  });

  it('unescapes IRCv3 tag values', async () => {
    const a = await boot();
    const parsed = a.api().parseIrcLine('@system-msg=Bob\\ssubscribed\\:\\syay :tmi.twitch.tv USERNOTICE #chan');
    assertEqual(parsed.tags['system-msg'], 'Bob subscribed; yay');
  });

  it('does not treat a message mentioning USERSTATE as a USERSTATE line', async () => {
    const a = await boot();
    const parsed = a.api().parseIrcLine(':bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :what is USERSTATE anyway');
    assertEqual(parsed.command, 'PRIVMSG');
    assertEqual(parsed.params[1], 'what is USERSTATE anyway');
  });

  it('handles lines without tags or prefix', async () => {
    const a = await boot();
    assertEqual(a.api().parseIrcLine('PING :tmi.twitch.tv').command, 'PING');
    assertEqual(a.api().parseIrcLine('').command, '');
  });
});

process.on('exit', () => { if (app) app.close(); });

describe('render: link edge cases', () => {
  it('links a URL wrapped in brackets', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'see (https://example.com/page) for more', {});
    a.flush();
    assertEqual(a.$('#feed .chat-link').getAttribute('href'), 'https://example.com/page');
    assertIncludes(a.$('#feed .m-body').textContent, '(https://example.com/page)');
  });

  it('keeps multiple links in one message separate', async () => {
    const a = await boot();
    a.api().addMsg('kick', 'user', 'https://a.example https://b.example', {});
    a.flush();
    const hrefs = a.$$('#feed .chat-link').map(el => el.getAttribute('href'));
    assertEqual(hrefs, ['https://a.example', 'https://b.example']);
  });

  it('leaves a bare domain as text', async () => {
    const a = await boot();
    a.api().addMsg('twitch', 'user', 'go to example.com now', {});
    a.flush();
    assertEqual(a.$$('#feed .chat-link').length, 0);
  });
});
