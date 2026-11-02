/** Offline follow-up to the reviewed T3 no-history patch. No installed app writes. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const PET_T3_BASE_SHA = 'edfa3310fa558fcdd02a476b7ed1818ff25aa0636d72f0e2573321ad91b7a9c3';
export const PET_RENDERER_SHAS = Object.freeze({ bubble: '0345c43b6a3bc9ff0443b51fd165c5e14522b8a2e955c1afe06134c6481b2b94', dialog: '6d0a8d805448305f06ff40d03594fb7956153c45cb7d887eaf3e13252024fe86' });
const replace = (s, a, b) => { if (s.split(a).length !== 2) throw Error('SURFPET_PATCH_ANCHOR_MISMATCH'); return s.replace(a, b); };
/** Renderer starts closed; only the main process installs a monotonic permit. */
export function patchPetRenderer(source, kind) {
  if (!PET_RENDERER_SHAS[kind] || crypto.createHash('sha256').update(source).digest('hex') !== PET_RENDERER_SHAS[kind]) throw Error('SURFPET_RENDERER_VERSION_MISMATCH');
  const close = kind === 'bubble' ? "stopAudio(); if (current) current = { ...current, audio: undefined, autoplay: false }; playBtn.classList.add('hidden'); durEl.textContent = '';" : "try { player.pause(); player.removeAttribute('src'); player.load(); } catch {} setPlaying('');";
  const gate = `  var mediaPlaybackPermit = { generation: -1, allowed: false };
  function mediaMayPlay(message) {
    return mediaPlaybackPermit.allowed && !document.hidden && !message?.suppressTts && message?.playbackGeneration === mediaPlaybackPermit.generation;
  }
  window.__surfcoreSetPlaybackPermit = permit => {
    if (!Number.isSafeInteger(permit?.generation) || permit.generation < 0 || typeof permit.allowed !== 'boolean') throw new Error('MEDIA_PLAYBACK_PERMIT_INVALID');
    if (permit.generation < mediaPlaybackPermit.generation || permit.generation === mediaPlaybackPermit.generation && permit.allowed !== mediaPlaybackPermit.allowed) return { ...mediaPlaybackPermit };
    const changed = permit.generation !== mediaPlaybackPermit.generation;
    mediaPlaybackPermit = { generation: permit.generation, allowed: permit.allowed };
    if (changed || !permit.allowed) { ${close} }
    ${kind === 'dialog' ? 'for (const [id, button] of buttons) button.disabled = !mediaMayPlay(messages.find(message => message.id === id));' : ''}
    return { ...mediaPlaybackPermit };
  };
`;
  let s = source;
  if (kind === 'bubble') {
    s = replace(s, '  async function playAudio() {', gate + '  async function playAudio() {');
    s = replace(s, '    if (!current?.audio?.url) return;', '    if (!mediaMayPlay(current) || !current?.audio?.url) return;');
    s = replace(s, '      await audioEl.play();', '      if (!mediaMayPlay(current)) { stopAudio(); return; }\n      await audioEl.play();');
    s = replace(s, '  function show(payload) {\n    current = payload;', '  function show(payload) {\n    payload = mediaMayPlay(payload) ? payload : { ...payload, audio: undefined, autoplay: false };\n    current = payload;');
  } else {
    s = replace(s, '  function playMessage(message) {', gate + '  function playMessage(message) {');
    s = replace(s, '    if (!message.audio?.url) return;', '    if (!mediaMayPlay(message) || !message.audio?.url) return;');
    s = replace(s, '      void player.play().catch(() => setPlaying(""));', '      if (!mediaMayPlay(message)) return;\n      void player.play().catch(() => setPlaying(""));');
    s = replace(s, '    button.className = "voice-play";', '    button.className = "voice-play";\n    button.disabled = !mediaMayPlay(message);');
  }
  return s;
}
export function patchPetMedia(source) {
  if (crypto.createHash('sha256').update(source).digest('hex') !== PET_T3_BASE_SHA) throw Error('SURFPET_VERSION_MISMATCH: apply the reviewed T3 consumer patch to the exact v0.2.3 dist first');
  let s = replace(source, '  withAbsoluteAudio(message) {\n', '  withAbsoluteAudio(message, generation = message?.playbackGeneration ?? this.mediaPlaybackGeneration) {\n    message = { ...message, playbackGeneration: generation };\n    if (message?.suppressTts || !this.mediaPlaybackAllowed || generation !== this.mediaPlaybackGeneration || this.config?.voice?.mediaSuppressed) return { ...message, audio: undefined };\n');
  s = replace(s, '    this.client.on("config", (config) => {\n      this.config = config;', '    this.client.on("config", (config) => {\n      this.config = config;\n      void this.applyMediaOutput(config).catch(() => this.broadcastDialog("chat:error", { message: "MEDIA_PAUSE_FAILED：请停止本机设备，重新连接桌宠；本地语音不会在旧音频未暂停时启动。" }));');
  s = replace(s, '      const config = await this.client.fetchConfig();\n      this.config = config;', '      const config = await this.client.fetchConfig();\n      this.config = config;\n      await this.applyMediaOutput(config);');
  const methods = `  mediaPlaybackGeneration = 0;
  mediaPlaybackAllowed = false;
  mediaPlaybackPolicyKey = null;
  async installPlaybackPermit(win, permit = { generation: this.mediaPlaybackGeneration, allowed: this.mediaPlaybackAllowed }) {
    if (!win || win.isDestroyed()) return;
    const result = await win.webContents.executeJavaScript("if (typeof window.__surfcoreSetPlaybackPermit !== 'function') throw new Error('MEDIA_RENDERER_PATCH_REQUIRED'); window.__surfcoreSetPlaybackPermit(" + JSON.stringify(permit) + ");");
    if (!result || result.generation !== permit.generation || result.allowed !== permit.allowed) throw new Error('MEDIA_RENDERER_GENERATION_STALE');
  }
  async applyMediaOutput(config) {
    const suppressed = config?.voice?.mediaSuppressed === true;
    const key = JSON.stringify([config?.role?.id || null, suppressed, config?.voice?.mediaSuppressionNonce || null]);
    if (key !== this.mediaPlaybackPolicyKey) {
      this.mediaPlaybackPolicyKey = key;
      this.mediaPlaybackGeneration++;
      this.mediaPlaybackAllowed = !suppressed;
      this.client.mediaPlaybackGeneration = this.mediaPlaybackGeneration;
    }
    const generation = this.mediaPlaybackGeneration;
    const permit = { generation, allowed: !suppressed };
    if (suppressed) {
      this.pauseBubbleAudio(); this.broadcastDialog("chat:pause-audio", {});
      if (this.bubblePayload) this.bubblePayload = { ...this.bubblePayload, audio: undefined, autoplay: false };
    }
    const windows = [this.dialog, this.bubble].filter(w => w && !w.isDestroyed());
    await Promise.all(windows.map(w => this.installPlaybackPermit(w, permit)));
    if ([this.dialog, this.bubble].some(w => w && !w.isDestroyed() && !windows.includes(w))) return;
    const nonce = config?.voice?.mediaSuppressionNonce;
    if (!suppressed || this.disposed || generation !== this.mediaPlaybackGeneration || this.mediaPlaybackPolicyKey !== key || this.config?.voice?.mediaSuppressionNonce !== nonce || !this.config?.voice?.mediaSuppressed || !/^[a-f0-9]{48}$/.test(nonce || '')) return;
    await this.client.request('/media/audio-suppressed', { method: 'POST', body: { nonce } });
  }
  openMediaControls() {
    const base = this.client.info?.baseUrl;
    if (!/^http:\\/\\/127\\.0\\.0\\.1(?::\\d+)?$/.test(base || '')) { this.broadcastDialog('chat:error', { message: 'MEDIA_HOST_UNAVAILABLE：请先连接 SurfCore，再打开本机设备。' }); return; }
    void import_electron.shell.openExternal(new URL('/dsh-surfcore/local-capabilities/media', base).href);
  }
`;
  s = replace(s, '  start() {\n    this.client.start();', methods + '  start() {\n    this.client.start();');
  s = replace(s, '  async request(pathname, options = {}) {', '  async request(pathname, options = {}) {\n    const playbackGeneration = this.mediaPlaybackGeneration ?? -1;');
  s = replace(s, '      return data ?? {};', `      if (data && typeof data === "object") {
        const stamp = value => value && typeof value === "object" ? { ...value, playbackGeneration } : value;
        if (Array.isArray(data.events)) data.events = data.events.map(stamp);
        if (Array.isArray(data.messages)) data.messages = data.messages.map(stamp);
        if (data.reply) data.reply = stamp(data.reply);
        if (data.userMessage) data.userMessage = stamp(data.userMessage);
      }
      return data ?? {};`);
  s = replace(s, '      const result = await this.client.chat(say, mode);', '      const playbackGeneration = this.mediaPlaybackGeneration;\n      const result = await this.client.chat(say, mode);');
  s = replace(s, 'this.withAbsoluteAudio(result.reply)', 'this.withAbsoluteAudio(result.reply, playbackGeneration)');
  s = replace(s, 'this.withAbsoluteAudio(result.userMessage)', 'this.withAbsoluteAudio(result.userMessage, playbackGeneration)');
  s = replace(s, '        memory_write: event.memory_write,', '        playbackGeneration: event.playbackGeneration,\n        memory_write: event.memory_write,');
  s = replace(s, '      proactive: true,\n      audio: event.audio', '      proactive: true,\n      playbackGeneration: event.playbackGeneration,\n      audio: event.audio');
  s = replace(s, '  displayBubble(payload) {\n    this.bubblePayload = payload;', '  displayBubble(payload) {\n    payload = { ...payload, playbackGeneration: payload.playbackGeneration ?? this.mediaPlaybackGeneration };\n    this.bubblePayload = payload;');
  s = replace(s, '      win2.webContents.send("bubble:show", payload);', `      const generation = payload.playbackGeneration;
      void this.installPlaybackPermit(win2).then(() => {
        if (win2.isDestroyed()) return;
        const current = generation === this.mediaPlaybackGeneration && this.mediaPlaybackAllowed;
        win2.webContents.send("bubble:show", current ? payload : { ...payload, audio: undefined, autoplay: false });
      }).catch(() => this.broadcastDialog("chat:error", { message: 'MEDIA_RENDERER_PATCH_REQUIRED：请重启已更新的桌宠，旧播放未获许可。' }));`);
  s = replace(s, '    win2.webContents.on("did-finish-load", () => {\n      win2.webContents.send("chat:state", this.statePayload());', '    win2.webContents.on("did-finish-load", () => {\n      void this.installPlaybackPermit(win2).catch(() => this.broadcastDialog("chat:error", { message: "MEDIA_RENDERER_PATCH_REQUIRED：请重启已更新的桌宠。" }));\n      win2.webContents.send("chat:state", this.statePayload());');
  s = replace(s, 'function chatMenuItems() {\n  return [', 'function chatMenuItems() {\n  return [\n    { label: "本机语音与窗口（需明确授权）", click: () => chatHost?.openMediaControls() },');
  s = replace(s, '      messageId: message.id,', '      messageId: message.id,\n      playbackGeneration: message.playbackGeneration,');
  return s;
}
/** Validate all three exact originals before producing any deployable bundle. */
export function patchPetMediaBundle({ main, bubble, dialog }) {
  const result = { main: patchPetMedia(main), bubble: patchPetRenderer(bubble, 'bubble'), dialog: patchPetRenderer(dialog, 'dialog') };
  return Object.freeze(result);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, output] = process.argv.slice(2); if (!source || !output || path.resolve(source) === path.resolve(output) || fs.existsSync(output)) throw Error('Usage: node scripts/patch-surfpet-media.mjs <T3-patched-offline-main.js> <new-offline-file.js>');
  fs.writeFileSync(output, patchPetMedia(fs.readFileSync(source, 'utf8')), { flag: 'wx' }); console.log('Offline pet media patch written; installed app unchanged.');
}
