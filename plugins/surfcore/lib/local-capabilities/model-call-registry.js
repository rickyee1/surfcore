import crypto from 'node:crypto';

// Out-of-band provenance: never add fields to a model request or prompt.
const calls = new WeakMap();
export function registerModelCall(options, metadata) {
  if (!options || typeof options !== 'object' || calls.has(options) || metadata.producer !== 'semantic-writer' || !metadata.taskId || !['qq', 'pet', 'bili'].includes(metadata.platform)) throw new TypeError('Invalid model call registration');
  calls.set(options, Object.freeze({ producer: metadata.producer, taskId: metadata.taskId, platform: metadata.platform, policyHash: metadata.policyHash ?? null }));
  return options;
}
export const readModelCall = options => calls.get(options);
export const policyHash = policy => crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export function freezeModelPolicy(value) {
  if (value === null) return null;
  const copy = structuredClone(value);
  const { hash, ...body } = copy;
  if (Object.keys(copy).sort().join(',') !== 'controls,hash,platform,schema' || body.schema !== 1 || !['qq', 'pet'].includes(body.platform) || !body.controls || hash !== policyHash(body)) throw new TypeError('Invalid frozen model policy');
  const c = body.controls;
  if (Object.keys(c).sort().join(',') !== 'adapterIdleTimeoutMs,contextWindow,maxTokens,model,provider,reasoningEffort,temperature,totalDeadlineMs' || typeof c.provider !== 'string' || !c.provider || typeof c.model !== 'string' || !c.model || c.temperature !== 0.2 || c.reasoningEffort !== 'off' || c.maxTokens !== (body.platform === 'pet' ? 700 : 3200) || c.contextWindow !== 1048576 || c.adapterIdleTimeoutMs !== 60000 || c.totalDeadlineMs !== null) throw new TypeError('Unsupported model policy controls');
  Object.freeze(copy.controls); return Object.freeze(copy);
}
