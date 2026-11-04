import { fault } from './a01-contract.mjs';
import { freezeModelPolicy, policyHash } from '../plugins/surfcore/lib/local-capabilities/model-call-registry.js';

export function createModelPolicy(selection, channel) {
  const platform = channel === 'p' ? 'pet' : ['qc', 'rv', 'rg'].includes(channel) ? 'qq' : null;
  if (!platform || typeof selection?.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) throw fault('MODEL_POLICY_INVALID', 'Freeze an exact provider/model and known trial channel.');
  const body = { schema: 1, platform, controls: { provider: selection.provider, model: selection.model, temperature: 0.2, maxTokens: platform === 'pet' ? 700 : 3200, reasoningEffort: 'off', contextWindow: 1048576, adapterIdleTimeoutMs: 60000, totalDeadlineMs: null } };
  return freezeModelPolicy({ ...body, hash: policyHash(body) });
}
export function requestControls(policy) {
  const { provider, model, temperature, maxTokens, reasoningEffort } = freezeModelPolicy(policy).controls;
  return { provider, model, temperature, maxTokens, reasoningEffort };
}
export function verifyPrepared(policy, prepared) {
  const c = requestControls(policy);
  if (Object.entries(c).some(([k, v]) => prepared?.config?.[k] !== v) || prepared?.context?.contextWindow !== policy.controls.contextWindow) throw fault('MODEL_POLICY_MISMATCH', 'Keep the failed call; freeze the actual resolved catalogue and controls before any batch.');
  return true;
}

// Explicit producer-side waterfall. No observer writes request controls.
// prepend makes this the outer middleware: apply policy after native selection.
export function installAgentPolicy(ctx, policy, steps = new Map()) {
  freezeModelPolicy(policy);
  return ctx.on('agent/request', async function (payload, next) {
    const resolved = await next();
    const agent = payload.agent;
    const sessionId = agent?.session?.id ?? agent?.id;
    if (!sessionId || !Number.isInteger(payload.turn) || !Number.isInteger(payload.step)) throw fault('AGENT_POLICY_SOURCE_UNKNOWN', 'The native waterfall must expose its agent, turn and step.');
    steps.set(sessionId, Object.freeze({ sessionId, turn: payload.turn, step: payload.step }));
    return { ...resolved, ...requestControls(policy) };
  }, { prepend: true });
}

export function verifyCallEvidence(call, policy) {
  const problems = [];
  try { verifyPrepared(policy, { config: call.preparedConfig ?? call.resolvedConfig, context: call.preparedContext ?? call.resolvedContext }); } catch { problems.push('MODEL_POLICY_MISMATCH'); }
  if (Object.entries(requestControls(policy)).some(([k, v]) => call.finalStreamControls?.[k] !== v && !(k === 'reasoningEffort' && call.producer === 'pet-chat' && call.finalStreamControls?.[k] === undefined && call.resolvedConfig?.[k] === v))) problems.push('FINAL_STREAM_CONTROLS_UNKNOWN');
  const source = { 'agent-loop': 'native-agent-marker', 'pet-chat': 'pet-chat-scope', 'semantic-writer': 'options-weakmap' };
  if (!source[call.producer] || call.producerSource !== source[call.producer] || (call.producer === 'semantic-writer' && (!call.taskId || call.platform !== policy.platform || call.policyHash !== policy.hash)) || (call.producer === 'agent-loop' && (call.isAgentLoopRequest !== true || !call.sessionId || !Number.isInteger(call.turn) || !Number.isInteger(call.step)))) problems.push('PRODUCER_NOT_VERIFIED');
  if (call.timeoutPolicy?.policyHash !== policy.hash || call.timeoutPolicy?.adapterIdleTimeoutMs !== 60000 || call.timeoutPolicy?.totalDeadlineMs !== null || call.timeoutPolicy?.adapterEvidence !== 'native-config') problems.push('TIMEOUT_POLICY_NOT_VERIFIED');
  return problems;
}
