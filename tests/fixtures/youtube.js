// Trimmed-down copies of the payload shapes YouTube actually returns, used to
// exercise the parsers without touching the network.

const LIVE_CHAT_CONTINUATION = 'Cg0KC1RFU1RfVE9LRU4x';
const LIVE_CHAT_CONTINUATION_2 = 'Cg0KC1RFU1RfVE9LRU4y';

const initialData = {
  contents: {
    liveChatRenderer: {
      continuations: [
        { invalidationContinuationData: { timeoutMs: 5000, continuation: 'TOP_CHAT_TOKEN' } },
      ],
      header: {
        liveChatHeaderRenderer: {
          viewSelector: {
            sortFilterSubMenuRenderer: {
              subMenuItems: [
                { title: 'Top chat', continuation: { reloadContinuationData: { continuation: 'TOP_CHAT_TOKEN' } } },
                { title: 'Live chat', continuation: { reloadContinuationData: { continuation: LIVE_CHAT_CONTINUATION } } },
              ],
            },
          },
        },
      },
      emojis: [
        {
          emojiId: 'UCxxxx/abcd',
          shortcuts: [':_cozy:'],
          isCustomEmoji: true,
          image: { thumbnails: [{ url: 'https://yt3.ggpht.com/cozy-24.png' }, { url: 'https://yt3.ggpht.com/cozy-48.png' }] },
        },
        {
          emojiId: ':wave:',
          shortcuts: [':wave:'],
          image: { thumbnails: [{ url: 'https://yt3.ggpht.com/wave.png' }] },
        },
      ],
    },
  },
};

function liveChatPage({ withData = true, apiKey = 'AIzaTestKey', clientVersion = '2.20240515.01.00' } = {}) {
  const dataScript = withData ? `var ytInitialData = ${JSON.stringify(initialData)};` : '';
  return `<!DOCTYPE html><html><head><title>Live chat</title></head><body>
<script>${dataScript}</script>
<script>ytcfg.set({"INNERTUBE_API_KEY":"${apiKey}","INNERTUBE_CONTEXT_CLIENT_VERSION":"${clientVersion}","VISITOR_DATA":"x","visitorData":"CgtWaXNpdG9yRGF0YQ%3D%3D"});</script>
</body></html>`;
}

function channelLivePage(videoId = 'dQw4w9WgXcQ', name = 'Test Channel') {
  return `<!DOCTYPE html><html><head>
<title>${name} - YouTube</title>
<link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}">
<meta property="og:url" content="https://www.youtube.com/watch?v=${videoId}">
</head><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${videoId}"}};</script></body></html>`;
}

const chatResponse = {
  continuationContents: {
    liveChatContinuation: {
      continuations: [
        { invalidationContinuationData: { timeoutMs: 4200, continuation: LIVE_CHAT_CONTINUATION_2 } },
      ],
      actions: [
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'msg-1',
                authorName: { simpleText: 'Regular Viewer' },
                authorExternalChannelId: 'UCviewer1',
                message: {
                  runs: [
                    { text: 'hello ' },
                    { emoji: { emojiId: 'UCxxxx/abcd', shortcuts: [':_cozy:'], isCustomEmoji: true, image: { thumbnails: [{ url: 'https://yt3.ggpht.com/cozy-48.png' }] } } },
                    { text: ' check ' },
                    { text: 'https://example.com/a?b=1&c=2', navigationEndpoint: { urlEndpoint: { url: 'https://example.com/a?b=1&c=2' } } },
                  ],
                },
                timestampUsec: '1700000000000000',
              },
            },
          },
        },
        {
          addChatItemAction: {
            item: {
              liveChatTextMessageRenderer: {
                id: 'msg-2',
                authorName: { simpleText: 'Chan Mod' },
                authorExternalChannelId: 'UCmod1',
                authorBadges: [
                  { liveChatAuthorBadgeRenderer: { tooltip: 'Moderator', icon: { iconType: 'MODERATOR' } } },
                ],
                message: { runs: [{ text: 'keep it friendly' }] },
                timestampUsec: '1700000001000000',
              },
            },
          },
        },
        {
          addChatItemAction: {
            item: {
              liveChatPaidMessageRenderer: {
                id: 'sc-1',
                authorName: { simpleText: 'Big Spender' },
                authorExternalChannelId: 'UCspender',
                purchaseAmountText: { simpleText: '$5.00' },
                message: { runs: [{ text: 'love the stream' }] },
                timestampUsec: '1700000002000000',
              },
            },
          },
        },
        {
          addChatItemAction: {
            item: {
              liveChatMembershipItemRenderer: {
                id: 'mem-1',
                authorName: { simpleText: 'New Member' },
                headerSubtext: { runs: [{ text: 'Welcome to the channel!' }] },
                timestampUsec: '1700000003000000',
              },
            },
          },
        },
        { markChatItemAsDeletedAction: { targetItemId: 'msg-1' } },
        { markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UCspender' } },
      ],
    },
  },
};

const endedChatResponse = {
  continuationContents: {
    liveChatContinuation: { actions: [] },
  },
};

module.exports = {
  initialData,
  liveChatPage,
  channelLivePage,
  chatResponse,
  endedChatResponse,
  LIVE_CHAT_CONTINUATION,
  LIVE_CHAT_CONTINUATION_2,
};
