/** Render the actual card with deterministic React hooks and mock fetch; no browser/account. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
let slots = [], cursor = 0, effects = [];
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
const slot = create => { const i = cursor++; return slots[i] ||= create(); };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, value => { state.value = typeof value === 'function' ? value(state.value) : value; }]; },
  useRef(initial) { return slot(() => ({ current: initial })); },
  useCallback(fn, deps) { const memo = slot(() => ({})); if (!same(memo.deps, deps)) { memo.deps = deps; memo.fn = fn; } return memo.fn; },
  useMemo(fn, deps) { const memo = slot(() => ({})); if (!same(memo.deps, deps)) { memo.deps = deps; memo.value = fn(); } return memo.value; },
  useEffect(fn, deps) { const effect = slot(() => ({})); if (!same(effect.deps, deps)) { effect.deps = deps; effects.push(() => { effect.cleanup?.(); effect.cleanup = fn(); }); } },
};
let client;
globalThis.window = { __ModuleLoader__: { load({ factory }) { client = factory(name => name === 'react' ? React : {}); } } };
const actualFetch = globalThis.fetch; const actualSetInterval = globalThis.setInterval; const actualClearInterval = globalThis.clearInterval;
const actualSetTimeout = globalThis.setTimeout;
const timers = [];
globalThis.setInterval = fn => { timers.push(fn); return fn; }; globalThis.clearInterval = () => {};
const requests = [];
const bvid = 'BV1xx411c7mD';
const backend = { ok: true, config: { enabled: false, intervalMinutes: 60, dailyMax: 4, cooldownMinutes: 90 }, running: false, local: true, nextBrowseAt: null, last: null, error: null, unifiedAttentionRequired: true };
const source = { bvid, title: '公开标题', author: '公开作者', description: '公开简介', subtitle: '', subtitleStatus: 'none', url: 'javascript:NOT_ALLOWED', basis: '仅标题、作者与简介，未观看画面。' };
let apiError = null; let runGate = null; let statusGate = null; let abortStatus = false;
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const action = String(url).split('/').at(-1); const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ url: String(url), method: opts.method || 'GET', body });
  if (apiError?.action === action) return respond(apiError.result, 409);
  if (action === 'status') {
    if (abortStatus) return await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return statusGate ? await statusGate : respond(backend);
  }
  if (action === 'config') { backend.config = { ...body }; return respond(backend); }
  if (action === 'preview') return respond({ ok: true, source: { ...source }, basis: source.basis, sends: false, modelCalled: false });
  if (action === 'run') { backend.running = true; return runGate ? await runGate : respond({ ok: true, outcome: 'sent' }); }
  if (action === 'stop') { backend.config.enabled = false; backend.running = false; return respond({ ...backend, stopped: true }); }
  throw new Error('unexpected API');
};
let tree; const artifacts = [];
function render() { cursor = 0; tree = client.__test.CompanionCard(); for (const effect of effects.splice(0)) effect(); return tree; }
const all = tree => Array.isArray(tree) ? tree.flatMap(all) : tree && typeof tree === 'object' ? [tree, ...all(tree.children)] : [];
const words = tree => Array.isArray(tree) ? tree.map(words).join(' ') : tree && typeof tree === 'object' ? words(tree.children) : typeof tree === 'string' ? tree : '';
const button = label => { const value = all(tree).find(node => node.type?.name === 'Btn' && words(node).includes(label)); assert.ok(value, `missing button: ${label}`); return value; };
const input = label => { const value = all(tree).find(node => node.type === 'input' && node.props['aria-label'] === label); assert.ok(value, label); return value; };
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); render(); };
const capture = label => artifacts.push({ label, tree: JSON.parse(JSON.stringify(tree, (_, value) => typeof value === 'function' ? `[function:${value.name}]` : value)) });
let count = 0;
async function check(name, run) { await run(); console.log(`ok ${++count} ${name}`); }
try {
  await import('../lib/client.js'); assert.ok(client.__test.CompanionCard);
  await check('first render loads status only; default closed and safe controls disabled', async () => {
    render(); assert.equal(button('立即运行').props.disabled, true); await tick();
    assert.match(words(tree), /已关闭/); assert.equal(requests.length, 1); assert.equal(requests[0].method, 'GET');
    assert.equal(input('浏览间隔（分钟）').props.value, 60); assert.equal(input('每天最多主动尝试').props.value, 4); assert.equal(input('联系冷却（分钟）').props.value, 90);
    assert.equal(button('立即运行').props.disabled, true); assert.equal(button('停止并关闭').props.disabled, true); capture('default disabled');
    assert.match(words(tree), /无需空闲30分钟.*正在对话时暂停.*新消息会取消旧想法/);
  });
  await check('explicit enable form does not execute; status polling preserves unsaved preferences', async () => {
    const enabled = all(tree).find(node => node.type === 'input' && node.props.type === 'checkbox'); enabled.props.onChange({ target: { checked: true } });
    input('浏览间隔（分钟）').props.onChange({ target: { value: '120' } }); input('每天最多主动尝试').props.onChange({ target: { value: '2' } }); input('联系冷却（分钟）').props.onChange({ target: { value: '120' } });
    render(); assert.match(words(tree), /保存并启用（仅主人私聊）/); assert.match(words(tree), /已关闭/);
    await timers[0](); await tick(); assert.equal(input('浏览间隔（分钟）').props.value, 120); assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  });
  await check('save posts only config fields; enable scope and unified restrictions remain visible', async () => {
    await button('保存并启用').props.onClick(); render();
    const saved = requests.findLast(r => r.url.endsWith('/config'));
    assert.equal(saved.method, 'POST'); assert.deepEqual(saved.body, { enabled: true, intervalMinutes: 120, dailyMax: 2, cooldownMinutes: 120 });
    assert.match(words(tree), /只向绑定主人私聊/); assert.match(words(tree), /统一注意力.*主动联系开关/); assert.match(words(tree), /安静时段、专注、冷却、预算和主人白名单始终生效/);
    assert.ok(all(tree).some(node => node.type === 'a' && node.props.href === '/dsh-surfcore/local-capabilities')); assert.equal(button('立即运行').props.disabled, false); capture('enabled with explicit scope');
  });
  await check('public preview calls only POST preview and shows actual metadata basis with canonical source link', async () => {
    await button('只读预览').props.onClick(); render(); const call = requests.at(-1);
    assert.equal(call.method, 'POST'); assert.equal(call.url, '/dsh-surfcore/api/companion/preview'); assert.deepEqual(call.body, {});
    assert.match(words(tree), /不调用模型，不发送/); assert.match(words(tree), /未取得官方字幕.*不代表看过完整视频/);
    const link = all(tree).find(node => node.type === 'a' && words(node) === '公开标题'); assert.equal(link.props.href, `https://www.bilibili.com/video/${bvid}`); assert.equal(link.props.rel, 'noopener noreferrer');
    assert.ok(!JSON.stringify(tree).includes('javascript:NOT_ALLOWED')); capture('metadata preview');
  });
  await check('official subtitle preview is accurately labeled and uses full-width read-only text', async () => {
    source.subtitleStatus = 'available'; source.subtitle = '官方字幕第一句。\n第二句。'; source.basis = '标题、作者、简介与官方字幕；未观看画面。';
    await button('只读预览').props.onClick(); render(); assert.match(words(tree), /查看已读取的官方字幕节选/);
    const field = all(tree).find(node => node.type === 'textarea'); assert.equal(field.props.readOnly, true); assert.equal(field.props.style.width, '100%'); assert.equal(field.props.value, source.subtitle); capture('subtitle preview');
  });
  await check('previous source/outcome is visible; unknown explicitly never implies automatic resend', async () => {
    backend.last = { at: Date.now(), bvid, outcome: 'unknown', basis: '仅标题与简介', materialStored: false, thoughtStored: false }; backend.nextBrowseAt = Date.now() + 3600000;
    await button('刷新状态').props.onClick(); render(); assert.match(words(tree), /结果未确认（不会补发）/); assert.match(words(tree), /上次来源/); assert.match(words(tree), /未声称材料或想法已保存/);
    backend.last.outcome = 'pending'; await button('刷新状态').props.onClick(); render(); assert.match(words(tree), /上轮结果待核对（不会补发）/); capture('unknown and unsettled outcomes');
  });
  await check('structured errors remain visible after background polling and can be recovered by explicit refresh', async () => {
    apiError = { action: 'preview', result: { ok: false, code: 'BILI_PUBLIC_TIMEOUT', error: '公开视频读取超时', hint: '检查网络后重试预览' } };
    await button('只读预览').props.onClick(); render(); assert.ok(all(tree).some(node => node.props.role === 'alert' && /BILI_PUBLIC_TIMEOUT.*检查网络后重试预览/.test(words(node))));
    await timers[0](); await tick(); assert.match(words(tree), /BILI_PUBLIC_TIMEOUT/);
    apiError = null; await button('刷新状态').props.onClick(); render(); assert.doesNotMatch(words(tree), /BILI_PUBLIC_TIMEOUT/); assert.equal(button('只读预览').props.disabled, false);
  });
  await check('late status cannot restore an enabled view after an explicit stop', async () => {
    let release; const stale = respond(backend); statusGate = new Promise(resolve => { release = resolve; }); const pending = button('刷新状态').props.onClick();
    await button('停止并关闭').props.onClick(); render(); assert.match(words(tree), /已关闭/);
    statusGate = null; release(stale); await pending; render(); assert.match(words(tree), /已关闭/); assert.equal(button('立即运行').props.disabled, true);
    all(tree).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); render(); await button('保存并启用').props.onClick(); render();
  });
  await check('request timeout is visible, actionable and recoverable without resending', async () => {
    abortStatus = true; globalThis.setTimeout = (fn, ms, ...args) => actualSetTimeout(fn, ms === 15000 ? 5 : ms, ...args);
    try { await button('刷新状态').props.onClick(); render(); assert.match(words(tree), /COMPANION_REQUEST_TIMEOUT.*不要重复点击补发/); }
    finally { abortStatus = false; globalThis.setTimeout = actualSetTimeout; }
    await button('刷新状态').props.onClick(); render(); assert.doesNotMatch(words(tree), /COMPANION_REQUEST_TIMEOUT/);
  });
  await check('run is explicitly a possible owner send; duplicate controls disabled while stop remains available', async () => {
    let resolveRun; runGate = new Promise(resolve => { resolveRun = resolve; });
    assert.match(words(button('立即运行')), /可能发给主人/); const running = button('立即运行').props.onClick(); render();
    assert.equal(button('运行中…').props.disabled, true); assert.equal(button('只读预览').props.disabled, true); assert.equal(input('浏览间隔（分钟）').props.disabled, true); assert.equal(button('停止并关闭').props.disabled, false);
    capture('running with stop available');
    await button('停止并关闭').props.onClick(); render(); const stop = requests.findLast(r => r.url.endsWith('/stop')); assert.equal(stop.method, 'POST'); assert.deepEqual(stop.body, {}); assert.equal(backend.config.enabled, false);
    resolveRun(respond({ ok: false, code: 'COMPANION_STOPPED', error: '本轮已取消', hint: '核对最近结果；不会补发' }, 409)); await running; render();
    assert.match(words(tree), /已关闭/); assert.match(words(tree), /COMPANION_STOPPED/); assert.equal(button('立即运行').props.disabled, true); runGate = null;
  });
  await check('status failure is actionable and refresh recovers; non-local backend cannot run or preview', async () => {
    apiError = { action: 'status', result: { ok: false, code: 'SERVICE_UNAVAILABLE', error: '状态读取失败', hint: '检查本地能力服务后刷新' } };
    await button('刷新状态').props.onClick(); render(); assert.match(words(tree), /SERVICE_UNAVAILABLE.*检查本地能力服务后刷新/);
    apiError = null; backend.local = false; await button('刷新状态').props.onClick(); render(); assert.doesNotMatch(words(tree), /SERVICE_UNAVAILABLE/); assert.equal(button('只读预览').props.disabled, true); assert.equal(button('立即运行').props.disabled, true); capture('non-local backend');
  });
  await check('card issues only frozen Companion endpoints and has no platform publication action', async () => {
    assert.ok(requests.every(r => /^\/dsh-surfcore\/api\/companion\/(status|config|preview|run|stop)$/.test(r.url)));
    assert.ok(requests.every(r => r.url.endsWith('/status') ? r.method === 'GET' : r.method === 'POST'));
    assert.ok(!all(tree).filter(node => node.type?.name === 'Btn').some(node => /发布|评论|动态|群聊/.test(words(node))));
    const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'); const bili = code.slice(code.indexOf('function BiliTab('), code.indexOf('function BiliTab(') + 18000);
    assert.match(bili, /h\(CompanionCard\)/); assert.equal(all(tree).find(node => node.props.className === 'qbw-card').props.style.width, '100%');
  });
  const evidence = path.resolve(import.meta.dirname, '../../../.local/evidence/t1u-companion-rendered-tree.json'); fs.mkdirSync(path.dirname(evidence), { recursive: true }); fs.writeFileSync(evidence, JSON.stringify({ kind: 'actual component rendered with mock React hooks; not browser screenshot', checks: count, scenarios: artifacts }, null, 2));
} finally { for (const value of slots) value?.cleanup?.(); globalThis.fetch = actualFetch; globalThis.setInterval = actualSetInterval; globalThis.clearInterval = actualClearInterval; globalThis.setTimeout = actualSetTimeout; }
console.log(`PASS ${count} Companion client checks; actual card rendering, mock HTTP only, no runtime configuration or messages.`);
