// Sonification: the agents make the sound. A voice is a tone at its note's key (MIDI pitch) that rings for the note's length at
// tempo and keeps sustaining while the agent runs (a slow agent is an audible drone); errors blip, Master chimes, the metronome
// clicks. A channel picks its instrument with `sound` (default by generator); `drums` maps keys like General MIDI.
// The same instruments render offline: renderWav() bounces a song's score to a WAV, like a DAW's export. Plain Web Audio.
const load = (k: string, d: any) => { try { const v = localStorage.getItem(`agentloops.sound.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k: string, v: any) => { try { localStorage.setItem(`agentloops.sound.${k}`, JSON.stringify(v)); } catch {} };
export const sound = { on: load("on", true) as boolean, vol: load("vol", 0.6) as number, metro: load("metro", false) as boolean };
const stats = { started: 0, stopped: 0, active: 0, chimes: 0, blips: 0, clicks: 0, events: 0, kicks: 0 };
(window as any).__sound = stats;
const MAX = 24; // ponytail: at most 24 sustained live tones; later voices are silent until one ends. Steal the oldest if big chords matter
export const FAMILIES: Record<string, string[]> = { lead: ["triangle", "sine", "square", "saw", "chip", "sax"], keys: ["piano"], bass: ["sub"], pad: ["supersaw"], mallets: ["pluck", "bell"], drums: ["drums"] };
export const SOUNDS = Object.values(FAMILIES).flat();
const ONESHOT = new Set(["pluck", "bell", "drums"]); // a sound in neither this nor SAMPLED is sustained (see SUSTAIN)
const span = (a: number, b: number) => Array.from({ length: (b - a) / 3 + 1 }, (_, i) => a + 3 * i); // a recorded note every minor third
// Sampled sounds: files ui/samples/<sound>/<root>.mp3 (mf) and <root>-p.mp3 (soft). The recording carries its own decay, so the envelope only
// holds it and releases at the note's end. ponytail: no loop points, so a note longer than its recording just ends with it; add crossfade loops if long held sax notes matter
const SAMPLED: Record<string, { roots: number[]; rel: number; peak: number; wet?: number }> = {
  piano: { roots: span(21, 105), rel: 0.3, peak: 0.4 },
  sax: { roots: span(49, 79), rel: 0.12, peak: 0.45, wet: 0.25 },
};
const BY_PLUGIN: Record<string, string> = { script: "triangle", "llm.agent": "saw", harness: "square" };

/** A sound rig on one audio context: master out (limited), a pump bus that ducks on kicks, a reverb send, shared noise. */
type Rig = { c: BaseAudioContext; out: GainNode; pump: GainNode; verb: GainNode; noise: AudioBuffer };
function rig(c: BaseAudioContext, vol: number): Rig {
  const comp = c.createDynamicsCompressor(); // a limiter so a full band never clips
  comp.threshold.value = -20; comp.knee.value = 6; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.2;
  const out = c.createGain(), pump = c.createGain(), verb = c.createGain(), conv = c.createConvolver(), wet = c.createGain();
  out.gain.value = vol; verb.gain.value = 1; wet.gain.value = 0.32;
  const len = Math.floor(c.sampleRate * 2.2), ir = c.createBuffer(2, len, c.sampleRate); // a soft hall: decaying stereo noise
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
  conv.buffer = ir;
  const nb = c.createBuffer(1, c.sampleRate, c.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  pump.connect(out); verb.connect(conv); conv.connect(wet); wet.connect(pump); out.connect(comp); comp.connect(c.destination);
  return { c, out, pump, verb, noise: nb };
}
let ac: AudioContext | null = null, R: Rig;
/** Browsers only allow audio after a user gesture: call this from Play, Space and the speaker button. */
export function unlock() {
  if (!ac) { try { ac = new AudioContext(); } catch { return; } R = rig(ac, sound.vol); loadSamples(ac, want); }
  ac.resume().catch(() => {});
}
const live = () => !!ac && sound.on && ac.state === "running";
export function setOn(v: boolean) { sound.on = v; save("on", v); if (v) unlock(); if (!v) stopAll(); }
export function setVol(v: number) { sound.vol = Math.max(0, Math.min(1, Math.round(v * 20) / 20)); save("vol", sound.vol); if (ac) R.out.gain.setTargetAtTime(sound.vol, ac.currentTime, 0.03); }
export function setMetro(v: boolean) { sound.metro = v; save("metro", v); if (v) unlock(); }

const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);
const osc = (r: Rig, type: OscillatorType, f: number, detune = 0) => { const o = r.c.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune; return o; };
const filt = (r: Rig, type: BiquadFilterType, f: number, q = 0.7) => { const b = r.c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
const gain = (r: Rig, v = 1) => { const g = r.c.createGain(); g.gain.value = v; return g; };
const pan = (r: Rig, v: number) => { const p = r.c.createStereoPanner(); p.pan.value = v; return p; };
/** a decaying envelope on a fresh gain: 0 → peak in `a`, then down to silence over `dur` */
const hit = (r: Rig, peak: number, t: number, dur: number, a = 0.004) => {
  const g = gain(r, 0.0001); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); return g;
};
const send = (r: Rig, from: AudioNode, amt: number) => { const s = gain(r, amt); from.connect(s); s.connect(r.verb); };

// Sustained instruments: oscillators → filter → envelope. Released by the later of the note's end and the voice's end (live),
// or at the note's end (offline).
type Sus = { make: (r: Rig, f: number, t: number) => { oscs: AudioScheduledSourceNode[]; head: AudioNode }; peak: number; hold: number; a: number; rel: number; pumped?: boolean; wet?: number };
const chain = (oscs: AudioScheduledSourceNode[], head: AudioNode) => ({ oscs, head });
const SUSTAIN: Record<string, Sus> = {
  triangle: { make: (r, f) => { const o = osc(r, "triangle", f); return chain([o], o); }, peak: 0.16, hold: 0.07, a: 0.02, rel: 0.45 },
  sine: { make: (r, f) => { const o = osc(r, "sine", f); return chain([o], o); }, peak: 0.18, hold: 0.12, a: 0.02, rel: 0.4 },
  square: { make: (r, f) => { const o = osc(r, "square", f), lp = filt(r, "lowpass", 2400); o.connect(lp); return chain([o], lp); }, peak: 0.06, hold: 0.025, a: 0.02, rel: 0.4 },
  saw: { make: (r, f) => { const o = osc(r, "sawtooth", f), lp = filt(r, "lowpass", 1400); o.connect(lp); return chain([o], lp); }, peak: 0.12, hold: 0.05, a: 0.02, rel: 0.45 },
  // the future-bass chord: five detuned saws spread across the stereo field, through a soft lowpass, pumped by the kick
  supersaw: {
    make: (r, f) => {
      const lp = filt(r, "lowpass", 3400), oscs = [-16, -8, 0, 8, 16].map((d, i) => { const o = osc(r, "sawtooth", f, d), p = pan(r, (i - 2) * 0.35); o.connect(p); p.connect(lp); return o; });
      return chain(oscs, lp);
    },
    peak: 0.05, hold: 0.04, a: 0.012, rel: 0.32, pumped: true, wet: 0.35,
  },
  sub: { make: (r, f) => { const lp = filt(r, "lowpass", 420), a = osc(r, "sine", f), b = osc(r, "triangle", f); a.connect(lp); b.connect(lp); return chain([a, b], lp); }, peak: 0.2, hold: 0.18, a: 0.008, rel: 0.12, pumped: true },
  chip: {
    make: (r, f, t) => { // an 8-bit lead with a little delayed vibrato
      const o = osc(r, "square", f), lfo = osc(r, "sine", 6), depth = gain(r, 0), lp = filt(r, "lowpass", 5200);
      depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(18, t + 0.25); lfo.connect(depth); depth.connect(o.detune); o.connect(lp);
      return chain([o, lfo], lp);
    },
    peak: 0.05, hold: 0.04, a: 0.006, rel: 0.08, wet: 0.2,
  },
};
/** start a sustained tone at t; returns its gain and sources so the caller can release it */
function sustain(r: Rig, kind: string, key: number, t: number, lvl: number) {
  const s = SUSTAIN[kind] ?? SUSTAIN.triangle, { oscs, head } = s.make(r, hz(key), t), g = gain(r, 0.0001);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.peak * lvl), t + s.a); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, s.hold * lvl), t + 0.35);
  head.connect(g); g.connect(s.pumped ? r.pump : r.out); if (s.wet) send(r, g, s.wet);
  oscs.forEach((x) => x.start(t));
  return { g, oscs, rel: s.rel };
}
// Sample buffers, cached per audio context. A failed download stays missing until reload (ponytail: no retry).
const bank = new WeakMap<BaseAudioContext, Map<string, { b?: AudioBuffer; p?: Promise<void> }>>();
const sampleName = (kind: string, root: number, soft: boolean) => `${kind}/${root}${soft ? "-p" : ""}`;
function fetchSample(c: BaseAudioContext, f: string) {
  let m = bank.get(c); if (!m) bank.set(c, (m = new Map()));
  if (!m.has(f)) { const e: { b?: AudioBuffer; p?: Promise<void> } = {}; m.set(f, e); e.p = fetch(`/ui/samples/${f}.mp3`, { cache: "no-store" }).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then((a) => c.decodeAudioData(a)).then((b) => { e.b = b; }).catch(() => {}); }
  return m.get(f)!;
}
/** load every layer of the given sampled sounds on c; resolves to the files that failed. ponytail: all roots, both layers, even if a song uses few */
async function loadSamples(c: BaseAudioContext, kinds: Iterable<string>) {
  const es = [...new Set(kinds)].filter((k) => SAMPLED[k]).flatMap((k) => SAMPLED[k].roots.flatMap((r) => [false, true].map((soft) => sampleName(k, r, soft)))).map((f) => [f, fetchSample(c, f)] as const);
  await Promise.all(es.map(([, e]) => e.p));
  return es.filter(([, e]) => !e.b).map(([f]) => f);
}
const want = new Set<string>();
/** Live: the song uses these sounds (a channel's `sound`s; unknown and synth ones are ignored). Loads now, or once Play unlocks the audio. */
export function preload(sounds: (string | undefined)[]) { for (const s of sounds) if (s && SAMPLED[s]) want.add(s); if (ac) loadSamples(ac, want); }
/** one sampled note: the nearest recorded root, repitched; null if its buffer isn't loaded (yet) */
function sampled(r: Rig, kind: string, key: number, t: number, lvl: number, vel: number) {
  const s = SAMPLED[kind], lo = s.roots[0], hi = s.roots[s.roots.length - 1];
  while (key < lo - 3) key += 12; while (key > hi + 3) key -= 12; // the edge roots may pitch 3 semitones outward (piano 106-108); beyond that, fold by octaves into the range
  const root = s.roots.reduce((a, b) => (Math.abs(b - key) < Math.abs(a - key) ? b : a)), b = bank.get(r.c)?.get(sampleName(kind, root, vel < 0.4))?.b;
  if (!b) return null;
  const src = r.c.createBufferSource(), g = gain(r, 0.0001);
  src.buffer = b; src.playbackRate.value = 2 ** ((key - root) / 12);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.peak * lvl * (0.5 + vel)), t + 0.005); // vel 0.5 is unity
  src.connect(g); g.connect(r.out); if (s.wet) send(r, g, s.wet);
  src.start(t);
  return { g, oscs: [src] as AudioScheduledSourceNode[], rel: s.rel };
}
/** release at `at` (≥ now): hold whatever the envelope is doing at that moment, then fade. Offline, `at` is far ahead of the attack. */
const release = (v: { g: GainNode; oscs: AudioScheduledSourceNode[]; rel: number }, now: number, at: number) => {
  const g: any = v.g.gain;
  if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at);
  else { g.cancelScheduledValues(Math.max(now, at)); g.setValueAtTime(Math.max(0.0001, g.value), Math.max(now, at)); } // ponytail: older engines jump to the current level
  g.exponentialRampToValueAtTime(0.0001, at + v.rel); v.oscs.forEach((x) => x.stop(at + v.rel + 0.05));
};
/** play one note of any instrument at time t on rig r; sustained and sampled kinds are returned for release, one-shots handle themselves. vel only matters to sampled ones */
function note(r: Rig, kind: string, key: number, t: number, lvl: number, vel = 0.5) {
  if (kind === "drums") { drum(r, key, t, lvl); return null; }
  if (ONESHOT.has(kind)) { (kind === "pluck" ? pluck : bell)(r, hz(key), t, lvl); return null; }
  if (SAMPLED[kind]) return sampled(r, kind, key, t, lvl, vel);
  return sustain(r, kind, key, t, lvl);
}

const tones = new Map<string, { g: GainNode; oscs: AudioScheduledSourceNode[]; rel: number; until: number }>();
export type VoiceSound = { sound?: string; gain?: number; dur?: number; vel?: number };
const kindOf = (plugin: string, s?: string) => (s && s !== "auto" ? s : BY_PLUGIN[plugin] ?? "triangle");
// Lookahead: an event carries the server clock (`at`, ms). Events play as far apart as the server sent them, LAG behind, so SSE and
// main-thread jitter doesn't flam a chord or swing the drums; an event later than LAG plays at once.
const LAG = 0.08;
let skew = Infinity, seen = 0;
/** Any live event: learn the audio-minus-server clock offset. A leaky minimum: the least-delayed event sets it, and it may creep up
 *  0.1 ms per second so an audio clock that runs fast can't eat the lookahead. ponytail: the session's first note can be late by its own delay */
export function heard(at?: number) {
  if (at == null || !ac) return;
  const now = ac.currentTime;
  skew = Math.min(now - at / 1000, skew + (now - seen) * 1e-4); seen = now;
}
const when = (at?: number) => { heard(at); return at == null ? ac!.currentTime : Math.max(ac!.currentTime, at / 1000 + skew + LAG); };
/** A voice started at server time `at`. `dur` is the note's length in seconds at tempo; the tone rings at least that long, longer while the agent runs. */
export function voiceStart(id: string, key: number, plugin: string, o: VoiceSound = {}, at?: number) {
  stats.events++;
  if (!live() || tones.has(id)) return;
  const kind = kindOf(plugin, o.sound);
  if (!ONESHOT.has(kind) && tones.size >= MAX) return;
  const t = when(at), v = note(R, kind, key ?? 60, t, o.gain ?? 1, o.vel);
  stats.started++;
  if (!v) { stats.stopped++; if (kind === "drums" && (key === 35 || key === 36)) stats.kicks++; return; }
  tones.set(id, { ...v, until: t + Math.max(0.05, (o.dur ?? 0) * 0.92) }); stats.active = tones.size;
}
/** The voice ended: release at the note's end if it hasn't come yet. failed: plus a dissonant blip. */
export function voiceEnd(id: string, failed = false, at?: number) {
  stats.events++;
  const v = tones.get(id);
  if (v && ac) { const t = when(at); release(v, ac.currentTime, Math.max(t, v.until)); tones.delete(id); stats.stopped++; stats.active = tones.size; }
  if (failed) blip();
}
export function stopAll() { for (const id of [...tones.keys()]) { tones.get(id)!.until = 0; voiceEnd(id); } }

/** one-shot pluck: two detuned saws through a lowpass that snaps shut */
function pluck(r: Rig, f: number, t: number, lvl: number) {
  const lp = filt(r, "lowpass", 6000, 2), g = hit(r, 0.13 * lvl, t, 0.5);
  lp.frequency.setValueAtTime(6000, t); lp.frequency.exponentialRampToValueAtTime(380, t + 0.3);
  [-6, 6].forEach((d, i) => { const o = osc(r, "sawtooth", f, d), p = pan(r, i ? 0.25 : -0.25); o.connect(p); p.connect(lp); o.start(t); o.stop(t + 0.55); });
  lp.connect(g); g.connect(r.pump); send(r, g, 0.25);
}
/** one-shot FM bell: a sine carrier with a 3.5× modulator whose depth fades, so it sparkles then rings */
function bell(r: Rig, f: number, t: number, lvl: number) {
  const car = osc(r, "sine", f), mod = osc(r, "sine", f * 3.5), idx = gain(r, f * 2.2), g = hit(r, 0.12 * lvl, t, 1.5, 0.002);
  idx.gain.setValueAtTime(f * 2.2, t); idx.gain.exponentialRampToValueAtTime(f * 0.02, t + 0.9);
  mod.connect(idx); idx.connect(car.frequency); car.connect(g); g.connect(r.pump); send(r, g, 0.4);
  for (const o of [car, mod]) { o.start(t); o.stop(t + 1.6); }
}
/** General MIDI-ish kit: 35/36 kick, 38/40 snare, 39 clap, 42/44 closed hat, 46 open hat, 49/57 crash; anything else is a rim click */
function drum(r: Rig, key: number, t: number, lvl: number) {
  const n = (f: BiquadFilterNode, peak: number, dur: number, at = t, wet = 0) => {
    const s = r.c.createBufferSource(), g = hit(r, peak * lvl, at, dur, 0.001); s.buffer = r.noise; s.connect(f); f.connect(g); g.connect(r.out); if (wet) send(r, g, wet); s.start(at); s.stop(at + dur + 0.02);
  };
  if (key === 35 || key === 36) {
    const o = osc(r, "sine", 160), g = hit(r, 0.9 * lvl, t, 0.38, 0.002);
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + 0.42);
    n(filt(r, "highpass", 3000), 0.12, 0.012); // the click of the beater
    const p = r.pump.gain; p.cancelScheduledValues(t); p.setValueAtTime(1, t); p.linearRampToValueAtTime(0.28, t + 0.012); p.setTargetAtTime(1, t + 0.04, 0.09);
  } else if (key === 38 || key === 40) {
    n(filt(r, "bandpass", 1800, 0.8), 0.5, 0.19, t, 0.2);
    const o = osc(r, "triangle", 190), g = hit(r, 0.28 * lvl, t, 0.11, 0.002); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + 0.14);
  } else if (key === 39) for (const d of [0, 0.011, 0.022]) n(filt(r, "bandpass", 1300, 1.2), 0.45, d === 0.022 ? 0.16 : 0.012, t + d, d === 0.022 ? 0.3 : 0);
  else if (key === 42 || key === 44) n(filt(r, "highpass", 7500), 0.22, 0.05);
  else if (key === 46) n(filt(r, "highpass", 6500), 0.2, 0.3);
  else if (key === 49 || key === 57) n(filt(r, "highpass", 4200), 0.26, 1.3, t, 0.3);
  else n(filt(r, "bandpass", 2600, 3), 0.25, 0.03);
}

function ping(freqs: number[], type: OscillatorType, peak: number, dur: number, at = 0) {
  const t = ac!.currentTime + at, g = hit(R, peak, t, dur, 0.005);
  g.connect(R.out);
  for (const f of freqs) { const o = osc(R, type, f); o.connect(g); o.start(t); o.stop(t + dur + 0.05); }
}
/** an error frame, a declined harness voice, a failed voice */
export function blip() { stats.events++; if (!live()) return; ping([233, 247], "square", 0.08, 0.14); stats.blips++; }
/** the run's first frame reached Master: a bright two-note chime */
export function chime() { stats.events++; if (!live()) return; ping([1568], "sine", 0.12, 0.7); ping([2093], "sine", 0.09, 0.9, 0.08); stats.chimes++; }
export function click(accent: boolean) { if (!live() || !sound.metro) return; ping([accent ? 1760 : 1175], "sine", accent ? 0.16 : 0.09, 0.05); stats.clicks++; }

// ---- export: bounce a score to WAV offline (faster than real time, sample-exact timing) ----
export type Score = { bpm: number; end: number; notes: { ch: string; key: number; start: number; len: number; vel?: number }[]; channels: { id: string; plugin?: string; sound?: string; gain?: number }[] };
/** Render the score with the same instruments and return a 16-bit stereo WAV. Ticks: 96 per beat. A 2 s tail lets reverb ring out. */
export async function renderWav(s: Score, rate = 44100): Promise<ArrayBuffer> {
  const sec = (ticks: number) => (ticks * 60) / s.bpm / 96, length = Math.ceil((sec(s.end) + 2) * rate);
  const c = new OfflineAudioContext(2, length, rate), r = rig(c, 0.8), chs = new Map(s.channels.map((x) => [x.id, x]));
  const miss = await loadSamples(c, s.channels.map((x) => kindOf(x.plugin ?? "script", x.sound))); // decode before rendering starts
  if (miss.length) throw new Error(`sample files failed to load: ${miss.slice(0, 3).join(", ")}${miss.length > 3 ? ` and ${miss.length - 3} more` : ""}`);
  for (const n of [...s.notes].sort((a, b) => a.start - b.start)) { // time order: each kick's pump automation cancels what follows it
    const ch = chs.get(n.ch), t = sec(n.start) + 0.05, v = note(r, kindOf(ch?.plugin ?? "script", ch?.sound), n.key, t, ch?.gain ?? 1, n.vel);
    if (v) release(v, t, t + Math.max(0.05, sec(n.len) * 0.92));
  }
  return wav(await c.startRendering());
}
/** AudioBuffer → 16-bit PCM WAV bytes */
function wav(b: AudioBuffer): ArrayBuffer {
  const chans = b.numberOfChannels, frames = b.length, data = frames * chans * 2, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, chans, true);
  v.setUint32(24, b.sampleRate, true); v.setUint32(28, b.sampleRate * chans * 2, true); v.setUint16(32, chans * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, data, true);
  const cd = [...Array(chans)].map((_, i) => b.getChannelData(i));
  for (let i = 0, o = 44; i < frames; i++) for (let ch = 0; ch < chans; ch++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, cd[ch][i])) * 0x7fff, true);
  return buf;
}
