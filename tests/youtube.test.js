const yt = require('../youtube');
const fx = require('./fixtures/youtube');

function textResponse(body, { status = 200, url = '' } = {}) {
  return { ok: status >= 200 && status < 300, status, url, text: async () => body, json: async () => JSON.parse(body) };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, url: '', json: async () => body, text: async () => JSON.stringify(body) };
}

describe('youtube: input parsing', () => {
  it('recognises every common video reference', () => {
    assertEqual(yt.parseVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assertEqual(yt.parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
    assertEqual(yt.parseVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assertEqual(yt.parseVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assertEqual(yt.parseVideoId('youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assertEqual(yt.parseVideoId('m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  it('does not mistake a channel reference for a video', () => {
    assertEqual(yt.parseVideoId('@somechannel'), null);
    assertEqual(yt.parseVideoId('https://www.youtube.com/@somechannel'), null);
    assertEqual(yt.parseVideoId('shortname'), null);
    assertEqual(yt.parseVideoId(''), null);
    assertEqual(yt.parseVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  });

  it('builds channel candidates for handles, ids, custom urls and bare names', () => {
    assertEqual(yt.channelLiveCandidates('@lofigirl'), ['https://www.youtube.com/@lofigirl/live']);
    assertEqual(
      yt.channelLiveCandidates('UCabcdefghijklmnopqrstuv'),
      ['https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live']
    );
    assertEqual(yt.channelLiveCandidates('https://www.youtube.com/c/SomeName'),
      ['https://www.youtube.com/c/SomeName/live']);
    assertEqual(yt.channelLiveCandidates('somechannel'), [
      'https://www.youtube.com/@somechannel/live',
      'https://www.youtube.com/c/somechannel/live',
      'https://www.youtube.com/user/somechannel/live',
    ]);
    assertEqual(yt.channelLiveCandidates('   '), []);
  });

  it('url-encodes names so a crafted query cannot escape the path', () => {
    const candidates = yt.channelLiveCandidates('evil/../../admin');
    candidates.forEach(url => assertNotIncludes(url, '/../'));
  });
});

describe('youtube: html scraping', () => {
  it('extracts a balanced JSON object even with braces inside strings', () => {
    const html = 'var ytInitialData = {"a":"}{ not real","b":{"c":1}};</script>';
    assertEqual(yt.extractJsonAfter(html, 'var ytInitialData ='), { a: '}{ not real', b: { c: 1 } });
  });

  it('handles escaped quotes inside the payload', () => {
    const html = 'var ytInitialData = {"a":"say \\"hi\\" }","b":2};';
    assertEqual(yt.extractJsonAfter(html, 'var ytInitialData ='), { a: 'say "hi" }', b: 2 });
  });

  it('returns null instead of throwing on truncated data', () => {
    assertEqual(yt.extractJsonAfter('var ytInitialData = {"a":1', 'var ytInitialData ='), null);
    assertEqual(yt.extractJsonAfter('nothing here', 'var ytInitialData ='), null);
  });

  it('reads the innertube key and client version', () => {
    const page = fx.liveChatPage();
    assertEqual(yt.extractApiKey(page), 'AIzaTestKey');
    assertEqual(yt.extractClientVersion(page), '2.20240515.01.00');
  });

  it('finds the video id from canonical, og:url or inline data', () => {
    assertEqual(yt.videoIdFromPageHtml(fx.channelLivePage('abcdefghijk')), 'abcdefghijk');
    assertEqual(
      yt.videoIdFromPageHtml('<html><body>{"videoId":"zzzzzzzzzzz"}</body></html>'),
      'zzzzzzzzzzz'
    );
    assertEqual(yt.videoIdFromPageHtml('<html></html>'), null);
  });
});

describe('youtube: live video resolution', () => {
  it('short-circuits when the input already is a video', async () => {
    let called = false;
    const result = await yt.resolveLiveVideo('https://youtu.be/dQw4w9WgXcQ', {
      fetchImpl: async () => { called = true; return textResponse(''); },
    });
    assertEqual(result.videoId, 'dQw4w9WgXcQ');
    assert(!called, 'should not hit the network for a direct video link');
  });

  it('resolves a handle through the /live page', async () => {
    const seen = [];
    const result = await yt.resolveLiveVideo('@lofigirl', {
      fetchImpl: async (url) => {
        seen.push(url);
        return textResponse(fx.channelLivePage('jfKfPfyJRdk', 'Lofi Girl'), { url });
      },
    });
    assertEqual(result.videoId, 'jfKfPfyJRdk');
    assertEqual(result.channelName, 'Lofi Girl');
    assertEqual(seen, ['https://www.youtube.com/@lofigirl/live']);
  });

  it('falls through to /c/ and /user/ when the handle 404s', async () => {
    const seen = [];
    const result = await yt.resolveLiveVideo('oldschool', {
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.includes('/@')) return textResponse('nope', { status: 404, url });
        if (url.includes('/c/')) return textResponse('<html></html>', { url });
        return textResponse(fx.channelLivePage('aaaaaaaaaaa'), { url });
      },
    });
    assertEqual(result.videoId, 'aaaaaaaaaaa');
    assertEqual(seen.length, 3);
  });

  it('reports a friendly error when nothing is live', async () => {
    await assertRejects(() => yt.resolveLiveVideo('offlinechannel', {
      fetchImpl: async (url) => textResponse('<html></html>', { url }),
    }), 'expected a rejection when no video id is found');
  });

  it('never throws a raw network error at the caller', async () => {
    await assertRejects(() => yt.resolveLiveVideo('boom', {
      fetchImpl: async () => { throw new Error('socket hang up'); },
    }));
  });

  it('rejects empty input', async () => {
    await assertRejects(() => yt.resolveLiveVideo('   ', { fetchImpl: async () => textResponse('') }));
  });
});

describe('youtube: live chat bootstrap', () => {
  it('prefers the unfiltered "Live chat" continuation over "Top chat"', async () => {
    const session = await yt.bootstrapLiveChat('dQw4w9WgXcQ', {
      fetchImpl: async (url) => textResponse(fx.liveChatPage(), { url }),
    });
    assertEqual(session.continuation, fx.LIVE_CHAT_CONTINUATION);
    assertEqual(session.apiKey, 'AIzaTestKey');
    assertEqual(session.clientVersion, '2.20240515.01.00');
  });

  it('collects custom channel emoji from the page', async () => {
    const session = await yt.bootstrapLiveChat('dQw4w9WgXcQ', {
      fetchImpl: async (url) => textResponse(fx.liveChatPage(), { url }),
    });
    assertEqual(session.emojis[':_cozy:'].url, 'https://yt3.ggpht.com/cozy-48.png');
    assertEqual(session.emojis[':_cozy:'].source, 'YouTube Channel');
    assertEqual(session.emojis[':wave:'].source, 'YouTube');
  });

  it('rejects an invalid video id without a request', async () => {
    await assertRejects(() => yt.bootstrapLiveChat('nope', { fetchImpl: async () => textResponse('') }));
  });

  it('reports a readable error when the page has no chat data', async () => {
    await assertRejects(() => yt.bootstrapLiveChat('dQw4w9WgXcQ', {
      fetchImpl: async (url) => textResponse(fx.liveChatPage({ withData: false }), { url }),
    }));
  });

  it('reports a readable error on an HTTP failure', async () => {
    await assertRejects(() => yt.bootstrapLiveChat('dQw4w9WgXcQ', {
      fetchImpl: async (url) => textResponse('nope', { status: 503, url }),
    }));
  });
});

describe('youtube: chat parsing', () => {
  const parsed = yt.parseChatActions(fx.chatResponse.continuationContents.liveChatContinuation.actions);

  it('parses plain messages with text, emoji and links', () => {
    const msg = parsed.messages.find(m => m.id === 'msg-1');
    assertEqual(msg.author, 'Regular Viewer');
    assertEqual(msg.kind, 'message');
    assertEqual(msg.runs[0], { type: 'text', text: 'hello ', url: '' });
    assertEqual(msg.runs[1].type, 'emoji');
    assertEqual(msg.runs[1].url, 'https://yt3.ggpht.com/cozy-48.png');
    assertEqual(msg.runs[3].url, 'https://example.com/a?b=1&c=2');
  });

  it('parses moderator badges', () => {
    const msg = parsed.messages.find(m => m.id === 'msg-2');
    assertEqual(msg.badges, [{ type: 'moderator', label: 'Moderator', iconUrl: '' }]);
  });

  it('parses super chats and memberships', () => {
    const sc = parsed.messages.find(m => m.id === 'sc-1');
    assertEqual(sc.kind, 'superchat');
    assertEqual(sc.amount, '$5.00');
    const mem = parsed.messages.find(m => m.id === 'mem-1');
    assertEqual(mem.kind, 'membership');
    assertEqual(mem.runs[0].text, 'Welcome to the channel!');
  });

  it('collects deletions by message id and by author', () => {
    assertEqual(parsed.removals[0], { id: 'msg-1', author: null });
    assertEqual(parsed.removals[1], { id: null, authorChannelId: 'UCspender' });
  });

  it('unwraps replay actions', () => {
    const result = yt.parseChatActions([
      { replayChatItemAction: { actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'r1', authorName: { simpleText: 'A' }, message: { runs: [{ text: 'x' }] } } } } }] } },
    ]);
    assertEqual(result.messages.length, 1);
    assertEqual(result.messages[0].id, 'r1');
  });

  it('ignores unknown renderers instead of crashing', () => {
    const result = yt.parseChatActions([
      { addChatItemAction: { item: { someBrandNewRenderer: { id: 'x' } } } },
      { addChatItemAction: {} },
      null,
      'garbage',
    ]);
    assertEqual(result.messages.length, 0);
  });

  it('survives a completely malformed action list', () => {
    assertEqual(yt.parseChatActions(undefined), { messages: [], removals: [] });
    assertEqual(yt.parseChatActions('nope'), { messages: [], removals: [] });
  });

  it('renders unicode emoji as text rather than an image', () => {
    const runs = yt.parseRuns({ runs: [{ emoji: { emojiId: '😀', image: { thumbnails: [{ url: 'https://x/1.png' }] } } }] });
    assertEqual(runs, [{ type: 'text', text: '😀', url: '' }]);
  });
});

describe('youtube: polling', () => {
  it('returns messages and the next continuation', async () => {
    const result = await yt.pollLiveChat(
      { apiKey: 'k', clientVersion: '2', continuation: fx.LIVE_CHAT_CONTINUATION },
      { fetchImpl: async () => jsonResponse(fx.chatResponse) }
    );
    assertEqual(result.continuation, fx.LIVE_CHAT_CONTINUATION_2);
    assertEqual(result.pollMs, 4200);
    assertEqual(result.ended, false);
    assertEqual(result.messages.length, 4);
  });

  it('posts the continuation token to the innertube endpoint', async () => {
    let seen = null;
    await yt.pollLiveChat(
      { apiKey: 'abc', clientVersion: '2.1', continuation: 'TOKEN', visitorData: 'VD' },
      {
        fetchImpl: async (url, options) => {
          seen = { url, body: JSON.parse(options.body) };
          return jsonResponse(fx.chatResponse);
        },
      }
    );
    assertIncludes(seen.url, '/youtubei/v1/live_chat/get_live_chat');
    assertIncludes(seen.url, 'key=abc');
    assertEqual(seen.body.continuation, 'TOKEN');
    assertEqual(seen.body.context.client.clientVersion, '2.1');
    assertEqual(seen.body.context.client.visitorData, 'VD');
  });

  it('flags the end of a stream when no continuation comes back', async () => {
    const result = await yt.pollLiveChat(
      { apiKey: 'k', clientVersion: '2', continuation: 'T' },
      { fetchImpl: async () => jsonResponse(fx.endedChatResponse) }
    );
    assertEqual(result.ended, true);
    assertEqual(result.continuation, '');
  });

  it('treats a missing liveChatContinuation as ended, not as a crash', async () => {
    const result = await yt.pollLiveChat(
      { apiKey: 'k', clientVersion: '2', continuation: 'T' },
      { fetchImpl: async () => jsonResponse({}) }
    );
    assertEqual(result.ended, true);
    assertEqual(result.messages, []);
  });

  it('rejects without a continuation token', async () => {
    await assertRejects(() => yt.pollLiveChat({ apiKey: 'k' }, { fetchImpl: async () => jsonResponse({}) }));
  });

  it('surfaces HTTP failures', async () => {
    await assertRejects(() => yt.pollLiveChat(
      { apiKey: 'k', clientVersion: '2', continuation: 'T' },
      { fetchImpl: async () => jsonResponse({}, 500) }
    ));
  });

  it('clamps absurd poll intervals into a sane range', () => {
    assertEqual(yt.clampPoll(50), 1000);
    assertEqual(yt.clampPoll(999999), 15000);
    assertEqual(yt.clampPoll(undefined), yt.DEFAULT_POLL_MS);
    assertEqual(yt.clampPoll('abc'), yt.DEFAULT_POLL_MS);
  });
});
