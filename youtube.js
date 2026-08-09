// Friendly Chat - YouTube live chat support (server side)
//
// YouTube does not expose a public chat API that works with only a channel
// name, and the browser cannot read youtube.com directly because of CORS.
// Everything here therefore runs in Node (Electron main process / local
// server) where cross-origin rules do not apply:
//
//   1. resolveLiveVideo()  - turn "@handle", "channel name", a channel id or
//                            any YouTube URL into the video id of the channel's
//                            current live stream.
//   2. bootstrapLiveChat() - load the live chat page once to pick up the
//                            InnerTube api key, client version and the first
//                            continuation token.
//   3. pollLiveChat()      - long-poll InnerTube for new chat items and return
//                            them in a normalized shape the renderer can use.
//
// No API key, OAuth client or third-party service is required. Every parser is
// written defensively: YouTube changes its payloads often, so anything that
// cannot be understood is skipped rather than thrown.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Consent cookies keep youtube.com from redirecting to consent.youtube.com in
// regions where the interstitial is mandatory.
const YT_COOKIE = 'CONSENT=YES+cb; SOCS=CAI; PREF=hl=en&gl=US';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

const DEFAULT_POLL_MS = 3000;
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 15000;

function ytHeaders(extra = {}) {
  return {
    'User-Agent': DESKTOP_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Cookie': YT_COOKIE,
    ...extra,
  };
}

// ── Input parsing ────────────────────────────────────────────────────────────

// Pulls a video id out of anything that looks like a YouTube video reference.
// Returns null when the input is a channel reference or unparseable.
function parseVideoId(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (VIDEO_ID_RE.test(value)) return value;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch (_) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null;

  const fromQuery = url.searchParams.get('v');
  if (fromQuery && VIDEO_ID_RE.test(fromQuery)) return fromQuery;

  const parts = url.pathname.split('/').filter(Boolean);
  if (['live', 'embed', 'shorts', 'v'].includes(parts[0]) && VIDEO_ID_RE.test(parts[1] || '')) {
    return parts[1];
  }
  return null;
}

// Builds the ordered list of channel pages to try for a query. Each candidate
// is a "/live" page because that URL redirects to whatever the channel is
// streaming right now.
function channelLiveCandidates(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];

  const base = 'https://www.youtube.com';
  const seen = new Set();
  const out = [];
  const push = (path) => {
    const url = `${base}${path}`;
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  };

  // Full URL to a channel page — reuse whatever form the user pasted.
  let asUrl = null;
  try {
    if (/youtube\.com/i.test(value)) {
      asUrl = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    }
  } catch (_) { asUrl = null; }

  if (asUrl) {
    const parts = asUrl.pathname.split('/').filter(Boolean);
    if (parts[0] && parts[0].startsWith('@')) push(`/${parts[0]}/live`);
    else if (parts[0] === 'channel' && parts[1]) push(`/channel/${encodeURIComponent(parts[1])}/live`);
    else if ((parts[0] === 'c' || parts[0] === 'user') && parts[1]) {
      push(`/${parts[0]}/${encodeURIComponent(parts[1])}/live`);
    }
    if (out.length) return out;
  }

  const explicitHandle = value.startsWith('@');
  const name = value.replace(/^@/, '').trim();
  if (!name) return [];

  if (CHANNEL_ID_RE.test(name)) {
    push(`/channel/${encodeURIComponent(name)}/live`);
    return out;
  }

  // An explicit @handle is unambiguous — do not waste requests on the legacy
  // /c/ and /user/ forms.
  push(`/@${encodeURIComponent(name)}/live`);
  if (explicitHandle) return out;
  push(`/c/${encodeURIComponent(name)}/live`);
  push(`/user/${encodeURIComponent(name)}/live`);
  return out;
}

// ── HTML scraping helpers ────────────────────────────────────────────────────

// Extracts a balanced JSON object that follows `marker` in `html`. Regex alone
// cannot do this because the payloads contain nested braces inside strings.
function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;

  let i = html.indexOf('{', at + marker.length);
  if (i === -1) return null;

  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

function extractInitialData(html) {
  return extractJsonAfter(html, 'var ytInitialData =')
      || extractJsonAfter(html, 'window["ytInitialData"] =')
      || extractJsonAfter(html, 'ytInitialData =');
}

function extractApiKey(html) {
  const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  return m ? m[1] : '';
}

function extractClientVersion(html) {
  const m = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)
        || html.match(/"clientVersion":"([\d.]+)"/);
  return m ? m[1] : '2.20240101.00.00';
}

function extractVisitorData(html) {
  const m = html.match(/"visitorData":"([^"]+)"/);
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch (_) { return m[1]; }
}

// Depth-first search for the first value stored under `key`. Used instead of
// hard-coded paths so a layout change in YouTube's payload does not break us.
function findFirst(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirst(item, key, depth + 1);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const value of Object.values(node)) {
    const found = findFirst(value, key, depth + 1);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

// Collects every object in the tree that owns `key`.
function collectAll(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return out;
  if (Array.isArray(node)) {
    node.forEach(item => collectAll(item, key, out, depth + 1));
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node);
  Object.values(node).forEach(value => collectAll(value, key, out, depth + 1));
  return out;
}

function textFrom(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r?.text || '').join('');
  return '';
}

function thumbUrl(thumbnails) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) return '';
  const best = thumbnails[thumbnails.length - 1];
  const url = best?.url || thumbnails[0]?.url || '';
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

// ── Live video resolution ────────────────────────────────────────────────────

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: ytHeaders(), redirect: 'follow' });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, url: res.url || url };
}

function videoIdFromPageHtml(html, finalUrl = '') {
  const fromFinalUrl = parseVideoId(finalUrl);
  if (fromFinalUrl) return fromFinalUrl;

  const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (canonical) {
    const id = parseVideoId(canonical[1]);
    if (id) return id;
  }
  const metaUrl = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i);
  if (metaUrl) {
    const id = parseVideoId(metaUrl[1]);
    if (id) return id;
  }
  const inline = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
  if (inline) return inline[1];
  return null;
}

function channelNameFromPageHtml(html) {
  const meta = html.match(/<meta\s+(?:itemprop|property)="(?:name|og:title)"\s+content="([^"]+)"/i);
  if (meta) return meta[1];
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) return title[1].replace(/\s*-\s*YouTube\s*$/i, '').trim();
  return '';
}

// Resolves any user input to a live video id.
// Returns { videoId, channelName, sourceUrl } or throws with a friendly message.
async function resolveLiveVideo(query, { fetchImpl = fetch } = {}) {
  const raw = String(query || '').trim();
  if (!raw) throw new Error('Enter a YouTube channel name, handle or livestream URL');

  // A URL is unambiguous. A bare token is not — plenty of channel names are
  // eleven characters long, so channel lookup is tried first and a bare video
  // id is only assumed once that fails.
  const looksLikeUrl = /^(https?:\/\/|(www\.|m\.)?(youtube\.com|youtu\.be)\/)/i.test(raw);
  if (looksLikeUrl) {
    const directVideo = parseVideoId(raw);
    if (directVideo) return { videoId: directVideo, channelName: '', sourceUrl: `https://www.youtube.com/watch?v=${directVideo}` };
  }

  const candidates = channelLiveCandidates(raw);
  if (!candidates.length && VIDEO_ID_RE.test(raw)) {
    return { videoId: raw, channelName: '', sourceUrl: `https://www.youtube.com/watch?v=${raw}` };
  }
  if (!candidates.length) throw new Error(`Could not understand "${raw}"`);

  let lastStatus = 0;
  for (const candidate of candidates) {
    let page;
    try {
      page = await fetchText(candidate, fetchImpl);
    } catch (_) {
      continue;
    }
    lastStatus = page.status;
    if (!page.ok) continue;

    const videoId = videoIdFromPageHtml(page.text, page.url);
    if (videoId) {
      return {
        videoId,
        channelName: channelNameFromPageHtml(page.text),
        sourceUrl: candidate,
      };
    }
  }

  // No channel matched — the input may still have been a raw video id.
  if (VIDEO_ID_RE.test(raw)) {
    return { videoId: raw, channelName: '', sourceUrl: `https://www.youtube.com/watch?v=${raw}` };
  }
  if (lastStatus && lastStatus !== 200) {
    throw new Error(`YouTube returned HTTP ${lastStatus} for "${raw}"`);
  }
  throw new Error(`"${raw}" does not appear to be live right now`);
}

// ── Live chat bootstrap ──────────────────────────────────────────────────────

function pickContinuation(container) {
  const list = Array.isArray(container) ? container : [container];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const data = entry.invalidationContinuationData
      || entry.timedContinuationData
      || entry.reloadContinuationData
      || entry.liveChatReplayContinuationData
      || entry.playerSeekContinuationData
      || null;
    if (data?.continuation) {
      return { continuation: data.continuation, pollMs: clampPoll(data.timeoutMs) };
    }
  }
  return null;
}

function clampPoll(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(ms)));
}

// "Live chat" (everything) is preferred over "Top chat" (filtered), which is
// what YouTube selects by default.
function unfilteredContinuation(initialData) {
  const subMenu = findFirst(initialData, 'sortFilterSubMenuRenderer');
  const items = subMenu?.subMenuItems;
  if (!Array.isArray(items)) return null;
  const live = items.find(item => /^live chat$/i.test(item?.title || ''))
            || items.find(item => !/top chat/i.test(item?.title || ''));
  const token = live?.continuation?.reloadContinuationData?.continuation;
  return token || null;
}

// Custom channel emoji (member emotes) and YouTube's own emoji set both show up
// in the live chat page payload. They are returned so the renderer can offer
// them in the emote picker.
function collectEmojis(initialData) {
  const emojis = {};
  collectAll(initialData, 'emojiId').forEach(emoji => {
    const shortcuts = Array.isArray(emoji.shortcuts) ? emoji.shortcuts : [];
    const url = thumbUrl(emoji?.image?.thumbnails);
    if (!url) return;
    const label = shortcuts[0]
      || emoji?.image?.accessibility?.accessibilityData?.label
      || emoji.emojiId;
    if (!label) return;
    emojis[label] = {
      url,
      source: emoji.isCustomEmoji ? 'YouTube Channel' : 'YouTube',
      shortcuts,
    };
  });
  return emojis;
}

async function bootstrapLiveChat(videoId, { fetchImpl = fetch } = {}) {
  if (!VIDEO_ID_RE.test(String(videoId || ''))) throw new Error('Invalid YouTube video id');

  const page = await fetchText(`https://www.youtube.com/live_chat?v=${videoId}&is_popout=1`, fetchImpl);
  if (!page.ok) throw new Error(`YouTube live chat page returned HTTP ${page.status}`);

  const initialData = extractInitialData(page.text);
  if (!initialData) throw new Error('Could not read YouTube live chat data (layout changed?)');

  const continuations = findFirst(initialData, 'continuations');
  const picked = pickContinuation(continuations);
  const continuation = unfilteredContinuation(initialData) || picked?.continuation || '';
  if (!continuation) throw new Error('This video does not have an active live chat');

  return {
    videoId,
    apiKey: extractApiKey(page.text),
    clientVersion: extractClientVersion(page.text),
    visitorData: extractVisitorData(page.text),
    continuation,
    pollMs: picked?.pollMs || DEFAULT_POLL_MS,
    emojis: collectEmojis(initialData),
    title: textFrom(findFirst(initialData, 'title')) || '',
  };
}

// ── Chat item parsing ────────────────────────────────────────────────────────

function parseBadges(authorBadges) {
  if (!Array.isArray(authorBadges)) return [];
  return authorBadges.map(entry => {
    const badge = entry?.liveChatAuthorBadgeRenderer;
    if (!badge) return null;
    const iconType = String(badge?.icon?.iconType || '').toLowerCase();
    const tooltip = badge.tooltip || '';
    const customUrl = thumbUrl(badge?.customThumbnail?.thumbnails);
    let type = 'member';
    if (iconType.includes('owner')) type = 'owner';
    else if (iconType.includes('moderator')) type = 'moderator';
    else if (iconType.includes('verified')) type = 'verified';
    else if (customUrl) type = 'member';
    return { type, label: tooltip || type, iconUrl: customUrl };
  }).filter(Boolean);
}

function parseRuns(message) {
  const runs = Array.isArray(message?.runs) ? message.runs : [];
  const out = [];
  runs.forEach(run => {
    if (typeof run?.text === 'string') {
      const url = run?.navigationEndpoint?.urlEndpoint?.url
               || run?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url
               || '';
      out.push({ type: 'text', text: run.text, url: /^https?:\/\//i.test(url) ? url : '' });
      return;
    }
    if (run?.emoji) {
      const emoji = run.emoji;
      const url = thumbUrl(emoji?.image?.thumbnails);
      const shortcuts = Array.isArray(emoji.shortcuts) ? emoji.shortcuts : [];
      const alt = shortcuts[0]
        || emoji?.image?.accessibility?.accessibilityData?.label
        || emoji.emojiId
        || '';
      // Standard unicode emoji come back with the character itself as emojiId
      // and no custom image worth downloading — render them as text.
      if (!url || (!emoji.isCustomEmoji && !/^[:_a-z0-9-]+$/i.test(String(emoji.emojiId || '')))) {
        out.push({ type: 'text', text: emoji.emojiId || alt, url: '' });
        return;
      }
      out.push({ type: 'emoji', url, alt, custom: !!emoji.isCustomEmoji });
    }
  });
  return out;
}

function baseMessage(renderer, kind) {
  return {
    kind,
    id: renderer?.id || '',
    author: textFrom(renderer?.authorName) || 'unknown',
    authorChannelId: renderer?.authorExternalChannelId || '',
    badges: parseBadges(renderer?.authorBadges),
    runs: parseRuns(renderer?.message),
    timestampUsec: renderer?.timestampUsec || '',
  };
}

// Turns a raw InnerTube action list into normalized messages.
function parseChatActions(actions) {
  const messages = [];
  const removals = [];
  if (!Array.isArray(actions)) return { messages, removals };

  actions.forEach(action => {
    // Replay streams wrap the real action one level deeper.
    const replay = action?.replayChatItemAction?.actions;
    if (Array.isArray(replay)) {
      const nested = parseChatActions(replay);
      messages.push(...nested.messages);
      removals.push(...nested.removals);
      return;
    }

    if (action?.markChatItemAsDeletedAction?.targetItemId) {
      removals.push({ id: action.markChatItemAsDeletedAction.targetItemId, author: null });
      return;
    }
    if (action?.markChatItemsByAuthorAsDeletedAction?.externalChannelId) {
      removals.push({ id: null, authorChannelId: action.markChatItemsByAuthorAsDeletedAction.externalChannelId });
      return;
    }

    const item = action?.addChatItemAction?.item;
    if (!item) return;

    if (item.liveChatTextMessageRenderer) {
      messages.push(baseMessage(item.liveChatTextMessageRenderer, 'message'));
      return;
    }
    if (item.liveChatPaidMessageRenderer) {
      const renderer = item.liveChatPaidMessageRenderer;
      const msg = baseMessage(renderer, 'superchat');
      msg.amount = textFrom(renderer.purchaseAmountText);
      messages.push(msg);
      return;
    }
    if (item.liveChatPaidStickerRenderer) {
      const renderer = item.liveChatPaidStickerRenderer;
      const msg = baseMessage(renderer, 'superchat');
      msg.amount = textFrom(renderer.purchaseAmountText);
      msg.runs = [{ type: 'text', text: 'sent a Super Sticker', url: '' }];
      messages.push(msg);
      return;
    }
    if (item.liveChatMembershipItemRenderer) {
      const renderer = item.liveChatMembershipItemRenderer;
      const msg = baseMessage(renderer, 'membership');
      if (!msg.runs.length) {
        msg.runs = [{ type: 'text', text: textFrom(renderer.headerSubtext) || 'became a member', url: '' }];
      }
      messages.push(msg);
      return;
    }
    if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
      const renderer = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
      const header = renderer?.header?.liveChatSponsorshipsHeaderRenderer || {};
      messages.push({
        kind: 'membership',
        id: renderer.id || '',
        author: textFrom(header.authorName) || 'Someone',
        authorChannelId: renderer.authorExternalChannelId || '',
        badges: parseBadges(header.authorBadges),
        runs: [{ type: 'text', text: textFrom(header.primaryText) || 'gifted memberships', url: '' }],
        timestampUsec: renderer.timestampUsec || '',
      });
      return;
    }
    if (item.liveChatViewerEngagementMessageRenderer) {
      const renderer = item.liveChatViewerEngagementMessageRenderer;
      const text = textFrom(renderer.message);
      if (text) messages.push({ kind: 'system', id: renderer.id || '', author: 'YouTube', badges: [], runs: [{ type: 'text', text, url: '' }], timestampUsec: renderer.timestampUsec || '' });
      return;
    }
  });

  return { messages, removals };
}

async function pollLiveChat(session, { fetchImpl = fetch } = {}) {
  const { apiKey, clientVersion, continuation, visitorData } = session || {};
  if (!continuation) throw new Error('Missing YouTube chat continuation');

  const endpoint = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}${apiKey ? '&' : '?'}prettyPrint=false`;
  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: clientVersion || '2.20240101.00.00',
        hl: 'en',
        gl: 'US',
        ...(visitorData ? { visitorData } : {}),
      },
    },
    continuation,
  };

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: ytHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`YouTube chat poll returned HTTP ${res.status}`);

  const data = await res.json();
  const live = data?.continuationContents?.liveChatContinuation;
  if (!live) {
    return { messages: [], removals: [], continuation: '', pollMs: DEFAULT_POLL_MS, ended: true, emojis: {} };
  }

  const { messages, removals } = parseChatActions(live.actions);
  const next = pickContinuation(live.continuations);

  return {
    messages,
    removals,
    continuation: next?.continuation || '',
    pollMs: next?.pollMs || DEFAULT_POLL_MS,
    ended: !next?.continuation,
    emojis: collectEmojis(live),
  };
}

module.exports = {
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  VIDEO_ID_RE,
  parseVideoId,
  channelLiveCandidates,
  extractJsonAfter,
  extractInitialData,
  extractApiKey,
  extractClientVersion,
  findFirst,
  collectAll,
  collectEmojis,
  videoIdFromPageHtml,
  channelNameFromPageHtml,
  parseBadges,
  parseRuns,
  parseChatActions,
  pickContinuation,
  clampPoll,
  resolveLiveVideo,
  bootstrapLiveChat,
  pollLiveChat,
  ytHeaders,
};
