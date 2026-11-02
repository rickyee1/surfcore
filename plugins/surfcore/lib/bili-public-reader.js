/** Bounded public research. Never reads account files or invokes the platform CLI. */
import crypto from 'node:crypto';
import { parseBiliVideo } from './bili-drafts.js';
import { candidateScore, selectDiverse } from '../tools/lib/feed-core.mjs';
import { CapabilityError } from './local-capabilities/supervisor.js';

const clean = (s, n) => Array.from(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, n).join('');
const mixin = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const unavailable = () => new CapabilityError('BILI_PUBLIC_UNAVAILABLE', '公开资料读取失败，本轮没有发送。', '检查网络或稍后重新预览；无需重新扫码。');

export function subtitleUrl(value) {
  const url = new URL(String(value).startsWith('//') ? `https:${value}` : value);
  if (url.protocol !== 'https:' || url.hostname !== 'aisubtitle.hdslb.com' || url.port || url.username || url.password || url.hash || !url.pathname.startsWith('/bfs/subtitle/')) throw unavailable();
  return url;
}

export function createBiliPublicReader({ fetchImpl = fetch, timeoutMs = 12000, now = Date.now } = {}) {
  async function json(url, signal, limit = 512 * 1024, subtitle = false) {
    const target = new URL(url);
    if (subtitle) subtitleUrl(target.href);
    else if (target.origin !== 'https://api.bilibili.com') throw unavailable();
    let timer; const control = new AbortController();
    const abort = () => control.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) control.abort();
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(target.href, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' }, signal: control.signal });
        if (!response.ok || Number(response.headers.get('content-length')) > limit) throw unavailable();
        const reader = response.body?.getReader(); if (!reader) throw unavailable();
        let size = 0; const parts = [];
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw unavailable(); parts.push(value); }
        } finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
      })(), new Promise((_, reject) => { timer = setTimeout(() => { reject(new CapabilityError('BILI_PUBLIC_TIMEOUT', '公开资料读取超时，本轮没有发送。', '检查网络后重试预览。')); control.abort(); }, timeoutMs); }), new Promise((_, reject) => {
        if (control.signal.aborted) reject(unavailable()); else control.signal.addEventListener('abort', () => reject(unavailable()), { once: true });
      })]);
    } catch (e) { if (e instanceof CapabilityError) throw e; throw unavailable(); }
    finally { clearTimeout(timer); control.abort(); signal?.removeEventListener('abort', abort); }
  }
  async function feed({ exclude = [], signal } = {}) {
    const result = await json('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', signal);
    if (result.code !== 0 || !Array.isArray(result.data?.list)) throw unavailable();
    const candidates = result.data.list.slice(0, 20).flatMap(item => {
      try {
        const bv = parseBiliVideo(item.bvid); if (exclude.includes(bv)) return [];
        return [{ bv, t: clean(item.title, 200), up: clean(item.owner?.name, 100), d: Number(item.duration) || 0, play: Number(item.stat?.view) || 0, dm: Number(item.stat?.danmaku) || 0, _score: candidateScore({ d: Number(item.duration) || 0, play: Number(item.stat?.view) || 0 }, []), _hits: [] }];
      } catch { return []; }
    });
    return selectDiverse(candidates, [], { n: 3, generic: 3, seed: Math.floor(now() / 3600000) }).picked.map(item => ({ bvid: item.bv, title: item.t, author: item.up }));
  }
  async function read(input, { signal } = {}) {
    const bvid = parseBiliVideo(input);
    const result = await json(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, signal);
    const data = result.data;
    if (result.code !== 0 || data?.bvid !== bvid || !data.title || typeof data.desc !== 'string' || !data.owner?.name) throw unavailable();
    const source = { bvid, title: clean(data.title, 200), author: clean(data.owner.name, 100), description: clean(data.desc, 4000), url: `https://www.bilibili.com/video/${bvid}`, subtitle: '', basis: '仅标题、作者和简介；未观看视频画面或读取评论、私信。', subtitleStatus: 'unavailable' };
    // Public subtitle availability is optional. A failure never becomes a claim of watching.
    try {
      const nav = await json('https://api.bilibili.com/x/web-interface/nav', signal);
      const key = value => String(value || '').split('/').at(-1)?.split('.')[0] || '';
      const raw = key(nav.data?.wbi_img?.img_url) + key(nav.data?.wbi_img?.sub_url);
      if (raw.length < 64 || !Number.isSafeInteger(data.cid) || data.cid <= 0) return source;
      const salt = mixin.map(i => raw[i]).join('').slice(0, 32);
      const params = new URLSearchParams({ bvid, cid: String(data.cid), wts: String(Math.floor(now() / 1000)) }); params.sort();
      params.set('w_rid', crypto.createHash('md5').update(params.toString() + salt).digest('hex'));
      const tracks = await json(`https://api.bilibili.com/x/player/wbi/v2?${params}`, signal);
      const list = tracks.code === 0 && Array.isArray(tracks.data?.subtitle?.subtitles) ? tracks.data.subtitle.subtitles.slice(0, 20) : [];
      const pick = list.find(t => ['zh-CN', 'ai-zh'].includes(t.lan)) || list[0];
      if (!pick) { source.subtitleStatus = 'none'; return source; }
      const body = await json(subtitleUrl(pick.subtitle_url), signal, 1024 * 1024, true);
      if (!Array.isArray(body.body)) return source;
      source.subtitle = clean(body.body.slice(0, 1000).map(line => clean(line.content, 500)).join('\n'), 6000);
      if (source.subtitle) { source.subtitleStatus = 'available'; source.basis = '标题、作者、简介与最多 6000 字符的官方字幕；未观看视频画面或读取评论、私信。'; }
    } catch { if (signal?.aborted) throw unavailable(); }
    return source;
  }
  return { feed, read };
}
