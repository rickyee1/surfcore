/** Fixed, one-shot host model calls. No history, tools, credential inspection or fallback. */
import crypto from 'node:crypto';
import { CapabilityError } from './supervisor.js';

const fail = (code, error, hint = '核对当前 DSH 模型配置后重新发起请求；旧结果不会重发。') => new CapabilityError(code, error, hint);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const EVENTS = ['loader/volatile-update', 'settings/document-updated', 'llm/adapters-updated', 'credentials/reference-updated'];
const textLength = value => Array.from(value).length;
// Cordis get() returns a fresh context facade. Unwrap only for identity checks;
// all service methods must still run through the original caller's facade.
const identityOf = service => service?.[Symbol.for('cordis.original')] ?? service;

/** Matches the reviewed DeepSeek Messages adapter, not an assumed OpenAI URL. */
export function messagesEndpoint(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.length > 2000) throw fail('FIXED_MODEL_UNSUPPORTED', '无法证明模型端点配置。');
  let parsed; try { parsed = new URL(baseURL); } catch { throw fail('FIXED_MODEL_UNSUPPORTED', '模型端点配置无效。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail('FIXED_MODEL_UNSUPPORTED', '模型端点不能包含凭据、查询或片段。');
  const base = baseURL.replace(/\/+$/u, '');
  return new URL(`${new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`}/messages`).href;
}

export function createFixedModel({ ctx, timeoutMs = 45000, onInvalidate = () => {}, onUsage = () => {} } = {}) {
  const hostId = crypto.randomBytes(24).toString('hex');
  const controllers = new Set(); const off = [];
  let generation = 0; let disposed = false;
  function invalidate() {
    generation++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    onInvalidate();
  }
  for (const name of EVENTS) {
    const dispose = ctx?.on?.(name, invalidate);
    if (typeof dispose === 'function') off.push(dispose);
  }
  // A service can be revoked and restored with the same underlying object.
  const serviceOff = ctx?.on?.('internal/service', name => { if (name === 'llm') invalidate(); });
  if (typeof serviceOff === 'function') off.push(serviceOff);
  function snapshot() {
    if (disposed) throw fail('FIXED_MODEL_STALE', '固定模型宿主已退出。');
    const selected = ctx?.get('agentDefaultModel')?.currentSelection?.();
    if (selected?.provider !== 'deepseek-official' || typeof selected.model !== 'string' || !selected.model || selected.model.length > 200) throw fail('FIXED_MODEL_UNSUPPORTED', '当前模型不支持已核验的固定工具结果交付。', '可在本机工具页查看结果；此路径目前仅支持已核验的 DeepSeek 官方适配器。');
    const llm = ctx?.get('llm'); const settings = ctx?.get('settings');
    if (typeof llm?.prepareCall !== 'function' || typeof llm.listConfigurableProviders !== 'function' || typeof settings?.describe !== 'function') throw fail('FIXED_MODEL_UNSUPPORTED', '宿主缺少固定模型或配置快照接口。');
    const providers = llm.listConfigurableProviders();
    if (!Array.isArray(providers)) throw fail('FIXED_MODEL_UNSUPPORTED', '模型目录不是可验证的同步快照。');
    const matching = providers.filter(item => item.provider === selected.provider);
    if (matching.length !== 1 || typeof matching[0].settingsNs !== 'string' || !Array.isArray(matching[0].settingsPath)) throw fail('FIXED_MODEL_UNSUPPORTED', '模型配置来源不唯一或无法证明。');
    const route = matching[0];
    const forms = settings.describe({ redactSecrets: true });
    if (!Array.isArray(forms)) throw fail('FIXED_MODEL_UNSUPPORTED', '模型配置不是可验证的同步快照。');
    const entries = forms.filter(form => form.ns === route.settingsNs && form.applies === 'live');
    if (entries.length !== 1 || !Number.isSafeInteger(entries[0].revision)) throw fail('FIXED_MODEL_UNSUPPORTED', '当前模型的生效配置无法唯一定位。');
    let value = entries[0].value;
    for (const key of route.settingsPath) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw fail('FIXED_MODEL_UNSUPPORTED', '模型配置路径无效。');
      value = value?.[key];
    }
    // Read only this allowlisted, non-secret route field. Never serialize config/credentials.
    // Match launchEnvironmentOf: ambient values are a fallback for an absent
    // snapshot, never for a variable absent from an existing launch snapshot.
    const environment = ctx?.get('launchEnvironment');
    const inheritedBase = environment == null ? process.env.DEEPSEEK_BASE_URL : environment.get('DEEPSEEK_BASE_URL')?.value;
    const baseURL = value?.baseURL ?? inheritedBase ?? 'https://api.deepseek.com/anthropic';
    const endpoint = messagesEndpoint(baseURL);
    const identity = { provider: selected.provider, model: selected.model, namespace: route.settingsNs, path: route.settingsPath, revision: entries[0].revision, endpoint };
    return { llm, llmIdentity: identityOf(llm), identity, fingerprint: digest(JSON.stringify(identity)), generation };
  }
  function pin({ signal } = {}) {
    const initial = snapshot(); const pinnedGeneration = generation;
    const target = Object.freeze({ provider: initial.identity.provider, model: initial.identity.model, config_revision: digest(`${hostId}:${pinnedGeneration}:${initial.fingerprint}`), endpoint_identity: digest(initial.identity.endpoint) });
    function validate() {
      if (signal?.aborted || disposed || generation !== pinnedGeneration) throw fail('FIXED_MODEL_STALE', '模型配置或原请求已变化，旧交付已取消。');
      const current = snapshot();
      if (generation !== pinnedGeneration || current.fingerprint !== initial.fingerprint || current.llmIdentity !== initial.llmIdentity) throw fail('FIXED_MODEL_STALE', '模型目标已经变化，不能给旧结果重新选模型。');
      return target;
    }
    async function prepare({ maxTokens = 1600, temperature = 0.2 } = {}) {
      validate();
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 100 || maxTokens > 4000 || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw fail('INVALID_REQUEST', '固定模型调用限额无效。');
      const controller = new AbortController(); controllers.add(controller);
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
      let used = false; let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller); };
      try {
        const prepared = await Promise.race([
          initial.llm.prepareCall({ provider: target.provider, model: target.model, reasoningEffort: 'off', maxTokens, temperature }, controller.signal),
          new Promise((_, reject) => { timer = setTimeout(() => { reject(fail('FIXED_MODEL_TIMEOUT', '准备固定模型超时。')); controller.abort(); }, timeoutMs); }),
          new Promise((_, reject) => { if (controller.signal.aborted) reject(fail('FIXED_MODEL_STALE', '准备固定模型已取消。')); else controller.signal.addEventListener('abort', () => reject(fail('FIXED_MODEL_STALE', '准备固定模型已取消。')), { once: true }); }),
        ]);
        clearTimeout(timer); validate();
        if (!prepared?.config || typeof prepared.stream !== 'function' || prepared.config.provider !== target.provider || prepared.config.model !== target.model) throw fail('FIXED_MODEL_UNSUPPORTED', '固定模型返回了不同目标。');
        const media = Object.freeze({ adapter_id: 'dsh-deepseek-messages', adapter_revision: '21fedb71f8d9aafea73b35ee13bc73737a8271d7ffa261697d4208e8563196cb', text_capable: prepared.mediaImageProtocol === 'surfcore-media-image-v1', image_capable: prepared.mediaImageProtocol === 'surfcore-media-image-v1' && prepared.inputModalities?.includes('image') === true });
        return Object.freeze({ target, validate, media, cancel() { controller.abort(); cleanup(); }, async text({ system, user, maxChars = 6000, image = null, mediaPermit = null } = {}) {
          if (used) throw fail('FIXED_MODEL_ALREADY_USED', '该固定模型调用已经使用，不会重放。');
          used = true;
          if (typeof system !== 'string' || system.length > 16000 || typeof user !== 'string' || user.length > 90000 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 12000) { controller.abort(); cleanup(); throw fail('INVALID_REQUEST', '固定模型输入或输出上限无效。'); }
          let usage, permit = null;
          try {
            validate(); let output = ''; let finished = false;
            let content = [{ type: 'text', text: user }];
            if (mediaPermit && (!media.text_capable || typeof mediaPermit.guard !== 'function' || typeof mediaPermit.syncGuard !== 'function' || Object.keys(mediaPermit).some(k => !['guard', 'syncGuard'].includes(k)))) throw fail('MEDIA_MODEL_UNSUPPORTED', '当前模型未连接受控媒体交付接口。', '检查隔离 DSH 的版本绑定媒体接缝并重启后重新录音；不会走普通聊天旁路。');
            if (image) {
              if (!media.image_capable || !(image.data instanceof Uint8Array) || image.data.length > 1500000 || typeof image.guard !== 'function' || typeof image.syncGuard !== 'function') throw fail('MEDIA_IMAGE_UNSUPPORTED', '当前固定模型未提供已审无历史图像入口。');
              content = [...content, { type: 'image', attachment: image.ref }];
            }
            const sourceGuard = mediaPermit || image;
            if (sourceGuard) permit = { ...(image || {}), kind: image ? 'image' : 'text', guard: async () => { validate(); await sourceGuard.guard(); validate(); }, syncGuard: () => { validate(); sourceGuard.syncGuard(); } };
            const generated = (async () => {
              for await (const part of prepared.stream({ ...prepared.config, system, messages: [{ role: 'user', content }], ...(permit ? { [Symbol.for('surfcore.media.image.v1')]: permit } : {}), signal: controller.signal })) {
                validate(); if (controller.signal.aborted) throw fail('FIXED_MODEL_STALE', '固定模型调用已取消。');
                if (finished && part?.type !== 'usage') throw fail('FIXED_MODEL_INCOMPLETE', '固定模型在结束标记后继续输出，没有交付。');
                if (part?.type === 'text-delta') output += String(part.text || '');
                if (part?.type === 'usage') usage = part.usage;
                if (textLength(output) > maxChars) throw fail('FIXED_MODEL_OUTPUT_INVALID', '固定模型输出超过上限，没有交付。');
                if (typeof part?.type === 'string' && /^tool(?:[-/]|$)/.test(part.type)) throw fail('FIXED_MODEL_OUTPUT_INVALID', '工具结果模型不能继续调用工具。');
                if (part?.type === 'finish') {
                  if (finished || part.reason?.kind !== 'stop') throw fail('FIXED_MODEL_INCOMPLETE', '固定模型未正常结束，没有交付。');
                  finished = true;
                }
              }
              validate();
              if (!finished || !output.trim()) throw fail('FIXED_MODEL_INCOMPLETE', '固定模型没有完整正文和正常结束标记。');
              return output.trim();
            })();
            return await Promise.race([generated, new Promise((_, reject) => { timer = setTimeout(() => { reject(fail('FIXED_MODEL_TIMEOUT', '固定模型回复超时，没有交付。')); controller.abort(); }, timeoutMs); }), new Promise((_, reject) => { if (controller.signal.aborted) reject(fail('FIXED_MODEL_STALE', '固定模型调用已取消。')); else controller.signal.addEventListener('abort', () => reject(fail('FIXED_MODEL_STALE', '固定模型调用已取消。')), { once: true }); })]);
          } catch (error) { if (error instanceof CapabilityError) throw error; throw fail('FIXED_MODEL_FAILED', '固定模型调用失败，没有交付。'); }
          finally { permit?.data?.fill(0); if (permit && image) permit.data = null; image?.data?.fill(0); if (image) image.data = null; if (usage) { try { onUsage({ usage, model: target.model }); } catch {} } controller.abort(); cleanup(); }
        } });
      } catch (error) { controller.abort(); cleanup(); if (error instanceof CapabilityError) throw error; throw fail('FIXED_MODEL_FAILED', '无法准备固定模型，没有交付。'); }
    }
    return Object.freeze({ target, validate, prepare, endpointOrigin: new URL(initial.identity.endpoint).origin });
  }
  function dispose() { if (disposed) return; disposed = true; invalidate(); for (const remove of off) remove(); }
  return { pin, invalidate, dispose, get generation() { return generation; } };
}
