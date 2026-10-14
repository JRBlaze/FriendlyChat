// Small shared rules for the standalone app; no browser-extension APIs.
(function(root, factory) {
  if(typeof module === 'object') module.exports = factory();
  else root.ChatFeatures = factory();
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const keyOf = item => `${item.platform}:${item.name}`;
  const usable = item => item.selectable !== false && !!item.url;

  function groups(entries, favorites, query) {
    const result = new Map();
    const q = query.trim().toLowerCase();
    for(const item of entries) {
      if(!usable(item) || !item.name.toLowerCase().includes(q)) continue;
      const favorite = favorites.includes(keyOf(item));
      const label = favorite ? 'Favorites' : item.owner
        ? `${item.owner} · ${item.platform === 'twitch' ? 'Twitch' : 'Kick'}` : item.source;
      const rank = favorite ? 0 : item.owner ? 1 : 2;
      if(!result.has(label)) result.set(label, { label, rank, items: [] });
      result.get(label).items.push(item);
    }
    return [...result.values()].sort((a,b) => a.rank - b.rank || a.label.localeCompare(b.label));
  }

  function readList(storage, key) {
    try {
      const value = JSON.parse(storage.getItem(key));
      return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string'))] : [];
    } catch(_) { return []; }
  }

  function preferences(storage) {
    const favorites = readList(storage, 'friendly_chat_emote_favorites_v1');
    const order = readList(storage, 'friendly_chat_recent_emotes_v1:order').slice(0,24);
    function write(key, value) {
      try { storage.setItem(key, JSON.stringify(value)); } catch(_) {}
    }
    return {
      favorites, order,
      toggle(item) {
        const key = keyOf(item), index = favorites.indexOf(key);
        if(index < 0) favorites.push(key);
        else favorites.splice(index,1);
        write('friendly_chat_emote_favorites_v1', favorites);
      },
      remember(platform, text, entries) {
        const words = text.split(/\s+/);
        const names = entries.filter(e => e.platform === platform && usable(e) && words.includes(e.name)).map(e => e.name);
        if(!names.length) return;
        const historyKey = `friendly_chat_recent_emotes_v1:${platform}`;
        const history = readList(storage, historyKey);
        for(const name of names) {
          const key = `${platform}:${name}`, index = order.indexOf(key);
          if(index >= 0) order.splice(index,1);
          order.unshift(key);
          const old = history.indexOf(name);
          if(old >= 0) history.splice(old,1);
          history.unshift(name);
        }
        order.splice(24);
        write(historyKey, history.slice(0,12));
        write('friendly_chat_recent_emotes_v1:order', order);
      },
      recent(entries, joined, width) {
        const limit = Math.max(0, Math.min(8, Math.floor((width + 4) / 36)));
        const available = new Map(entries.filter(e => usable(e) && joined[e.platform]).map(e => [keyOf(e), e]));
        return order.filter(key => available.has(key)).slice(0,limit).map(key => available.get(key));
      },
    };
  }

  function outgoing(platform, text, native) {
    if(platform !== 'kick') return text;
    return text.replace(/\S+/g, word => {
      const emote = native[word];
      return emote && usable(emote) && /^\d+$/.test(String(emote.id)) ? `[emote:${emote.id}:${word}]` : word;
    });
  }

  function destinations(text, targets, entries) {
    // Cheer syntax must stay on Twitch even when both destinations are selected.
    if(/\bcheer\d+\b/i.test(text)) return targets.filter(p => p === 'twitch');
    const words = text.trim().split(/\s+/);
    const names = new Set(entries.map(e => e.name));
    if(!words.every(word => names.has(word))) return targets;
    return targets.filter(platform => words.every(word => entries.some(e => e.platform === platform && e.name === word && usable(e))));
  }

  function retry(attempt) {
    return attempt >= 10 ? { delay: 300000, attempt: 0 } : { delay: Math.min(30000, 2000 * 2 ** attempt), attempt: attempt + 1 };
  }

  function pusherUrl(payload) {
    const data = payload && payload.data;
    const app = data && data.mode === 'websocket' && Array.isArray(data.connections)
      && data.connections.find(c => c && c.provider === 'pusher');
    const credentials = app && app.credentials;
    if(!credentials || typeof credentials.app_key !== 'string' || !/^[a-zA-Z0-9]+$/.test(credentials.app_key)
      || typeof credentials.cluster !== 'string' || !/^[a-z0-9-]+$/.test(credentials.cluster)) throw Error('Invalid chat connection');
    return `wss://ws-${credentials.cluster}.pusher.com/app/${credentials.app_key}?protocol=7&client=js&version=7.4.0&flash=false`;
  }

  function validModeration(action, duration) {
    return ['delete','timeout','ban','unban'].includes(action)
      && (action !== 'timeout' || Number.isInteger(duration) && duration >= 1 && duration <= 1209600);
  }
  function pinParameters(action, messageId, seconds) {
    if(!['pin','unpin'].includes(action) || typeof messageId !== 'string' || !messageId
      || seconds !== undefined && (!Number.isInteger(seconds) || seconds < 30 || seconds > 1800)) return null;
    return `message_id=${encodeURIComponent(messageId)}` + (action === 'pin' && seconds !== undefined ? `&duration_seconds=${seconds}` : '');
  }

  function youtubeBadgeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && /^(?:yt3\.ggpht\.com|yt3\.googleusercontent\.com|(?:www|ssl)\.gstatic\.com)$/.test(url.hostname) ? url.href : '';
    } catch(_) { return ''; }
  }

  function mediaLifecycle(feed, Observer) {
    const rows = new Map(), document = feed.ownerDocument;
    function display(row, visible) {
      row.querySelectorAll('img').forEach(image => {
        if(!visible && image.hasAttribute('src')) {
          image.dataset.chatSrc = image.getAttribute('src');
          image.dataset.chatWidth = image.style.width;
          image.dataset.chatHeight = image.style.height;
          const bounds = image.getBoundingClientRect();
          image.style.width = (bounds.width || 28) + 'px';
          image.style.height = (bounds.height || 28) + 'px';
          image.removeAttribute('src');
        } else if(visible && image.dataset.chatSrc) {
          image.setAttribute('src', image.dataset.chatSrc);
          image.style.width = image.dataset.chatWidth;
          image.style.height = image.dataset.chatHeight;
          delete image.dataset.chatSrc; delete image.dataset.chatWidth; delete image.dataset.chatHeight;
        }
      });
    }
    const observer = Observer ? new Observer(entries => {
      for(const entry of entries) {
        if(!rows.has(entry.target)) continue;
        rows.set(entry.target, entry.isIntersecting);
        display(entry.target, entry.isIntersecting && !document.hidden);
      }
    }, { root:feed, rootMargin:'100px' }) : null;
    const visibility = () => rows.forEach((visible,row) => display(row,visible && !document.hidden));
    document.addEventListener('visibilitychange',visibility);
    return {
      attach(row) {
        if(!observer || rows.has(row) || !row.querySelector('img')) return;
        rows.set(row,true); observer.observe(row);
        if(document.hidden) display(row,false);
      },
      prune() {
        rows.forEach((_,row) => { if(!feed.contains(row)) { observer.unobserve(row); rows.delete(row); } });
      },
      stop() {
        if(observer) observer.disconnect();
        document.removeEventListener('visibilitychange',visibility);rows.clear();
      },
    };
  }

  return { keyOf, usable, groups, preferences, outgoing, destinations, retry, pusherUrl, validModeration, pinParameters, youtubeBadgeUrl, mediaLifecycle };
});
