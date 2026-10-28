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
export const FAMILIES: Record<string, string[]> = { lead: ["triangle", "sine", "square", "saw", "chip", "brass", "flute", "whistle", "chop"], horns: ["sax", "trumpet", "trombone"], strings: ["strings", "violin", "pizz", "harp"], keys: ["piano", "epiano", "organ", "synorgan"], bass: ["sub", "upright", "finger", "slap", "ebass", "reese", "acid", "wobble", "808", "growl"], guitar: ["eguitar", "distguitar", "guitar", "heavy", "crunch", "chug", "clean"], voice: ["choir", "ooh", "shout"], pad: ["supersaw", "pad", "synchoir"], mallets: ["pluck", "bell", "marimba", "vibes", "glock", "timpani"], drums: ["drums", "brushes", "rock"], fx: ["noise"] };
export const SOUNDS = Object.values(FAMILIES).flat();
const ONESHOT = new Set(["pluck", "bell", "marimba", "drums", "brushes", "rock", "shout"]); // a sound in neither this nor SAMPLED is sustained (see SUSTAIN)
const span = (a: number, b: number) => Array.from({ length: (b - a) / 3 + 1 }, (_, i) => a + 3 * i); // a recorded note every minor third
// Sampled sounds: files ui/samples/<sound>/<root>.mp3 (mf) and <root>-p.mp3 (soft; `soft: false` = mf only). The recording carries its own decay, so the envelope only
// holds it and releases at the note's end. A held sound has a `loop` [start, end] (s, the same for all its files; keep in sync with scripts/samples.mjs): each file ends at the
// loop's end with a crossfade baked in, so it loops for as long as the note. `swell`: the attack at vel 0, shrinking as vel rises (strings swell in when played soft).
// `takes`: a panned note is one side of a double-track (see string()): detuned 4 cents by side and 0-8 ms late, since one recording per note would sum to mono.
// `dead`: under vel 0.4 a note is a dead (muted) note instead of soft: that sound's file at the same root (it shares the roots), choked within ~50 ms.
// `choke`: a note shorter than 0.25 s decays from its attack (time constant, s), like a strum the hand chokes, instead of holding the recording flat.
// `leslie`: a rotating speaker (tremolo and auto-pan, 0.8 Hz), and vel 0.7 and up adds the percussion (a decaying 3rd harmonic, the 2⅔' drawbar).
const SAMPLED: Record<string, { roots: number[]; rel: number; peak: number; wet?: number; loop?: [number, number]; soft?: false; swell?: number; takes?: true; dead?: string; choke?: number; leslie?: true }> = {
  piano: { roots: span(21, 105), rel: 0.3, peak: 0.4 },
  sax: { roots: span(49, 79), rel: 0.12, peak: 0.45, wet: 0.25, loop: [1, 2.2] },
  upright: { roots: span(28, 67), rel: 0.08, peak: 0.65 }, // plucked: it decays on its own
  vibes: { roots: span(48, 87), rel: 0.5, peak: 0.4, wet: 0.3 }, // a damped bar
  trombone: { roots: span(40, 70), rel: 0.12, peak: 1.4, wet: 0.25, loop: [0.5, 1.4] }, // brass is spikier than the sax, so peak-normalized files sit ~6 dB lower
  trumpet: { roots: span(52, 85), rel: 0.12, peak: 0.9, wet: 0.25, loop: [1, 3.4] },
  strings: { roots: [36, 40, 43, 47, 50, 53, 57, 60, 62, 65, 69, 72, 76, 79, 83, 86], rel: 0.4, peak: 0.5, wet: 0.35, loop: [2.5, 5], swell: 0.6 }, // cello section to 60, violas 62-69, violins from 72
  violin: { roots: [55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 84, 88, 91, 93, 96], rel: 0.25, peak: 0.75, wet: 0.3, loop: [4, 6.5] }, // solo, arco with vibrato
  pizz: { roots: [55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 88, 93], rel: 0.1, peak: 0.6, wet: 0.3 }, // solo violin pizzicato; soft layer up to 81, one dynamic above
  harp: { roots: [28, 35, 38, 41, 45, 48, 52, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86, 89, 93, 95, 98, 101], rel: 0.6, peak: 0.45, wet: 0.3, soft: false },
  glock: { roots: [79, 84, 91, 96, 103, 108], rel: 0.8, peak: 0.8, wet: 0.3, soft: false },
  timpani: { roots: [41, 47, 49, 52, 55], rel: 0.5, peak: 1.2, wet: 0.2 }, // five drums, each repitched around its tuning
  heavy: { roots: span(40, 88), rel: 0.08, peak: 0.26, soft: false, takes: true }, // recorded distortion guitar, Musyng Kite (CC BY-SA 3.0)
  crunch: { roots: span(40, 88), rel: 0.08, peak: 0.39, soft: false, takes: true }, // recorded overdriven guitar, Musyng Kite (CC BY-SA 3.0)
  chug: { roots: span(40, 88), rel: 0.05, peak: 1.05, soft: false, takes: true }, // recorded palm-muted electric guitar, Musyng Kite (CC BY-SA 3.0)
  clean: { roots: span(40, 88), rel: 0.15, peak: 0.58, soft: false, takes: true, dead: "chug", choke: 0.1 }, // recorded clean electric guitar, Musyng Kite (CC BY-SA 3.0); dead notes are the palm-muted chug, choked
  finger: { roots: span(28, 67), rel: 0.06, peak: 0.25, soft: false, dead: "finger" }, // recorded fingerstyle electric bass, Musyng Kite (CC BY-SA 3.0)
  slap: { roots: span(28, 67), rel: 0.06, peak: 0.5, soft: false, dead: "slap" }, // recorded slap bass, Musyng Kite (CC BY-SA 3.0)
  organ: { roots: span(36, 96), rel: 0.08, peak: 0.3, wet: 0.15, loop: [1, 2.5], soft: false, leslie: true }, // recorded drawbar organ, FluidR3 (CC BY 3.0)
  flute: { roots: [60, 64, 69, 72, 76, 81, 84, 88, 93, 96], rel: 0.15, peak: 0.5, wet: 0.25, loop: [1.5, 3.6], soft: false }, // concert flute with vibrato, VSCO 2 CE (CC0)
  choir: { roots: span(48, 84), rel: 0.5, peak: 0.45, wet: 0.4, loop: [1, 2.5], soft: false }, // "aah" choir, Musyng Kite (CC BY-SA 3.0)
  ooh: { roots: span(48, 84), rel: 0.5, peak: 0.35, wet: 0.4, loop: [1, 2], soft: false }, // "ooh" voices, FluidR3 (CC BY 3.0)
};
const WORDS = ["hey", "ha", "woo", "yeah"]; // the shouts, files shout/<word> (Freesound, CC0)
const KITS = ["drums", "brushes", "rock"], CYMBAL: Record<number, string> = { 49: "cymbals/49", 57: "cymbals/49", 52: "cymbals/52", 55: "cymbals/55", 51: "ride/51", 59: "ride/51", 53: "ride/53" }; // every kit shares the sampled cymbals: crash (49, 57), china (52), splash (55), ride bow (51, 59) and bell (53), each mf and soft (-p)
const RATE = 44100; // the sample files' rate: the live context and the export both run at it, so one decode of each file serves both (an AudioBuffer works in any context)
const BY_PLUGIN: Record<string, string> = { script: "triangle", "llm.agent": "saw", harness: "square" };

/** A sound rig on one audio context: master out (into the master stage), a pump bus that ducks on kicks (`duck` is its gain stage, even when a note gets its own `pump`), a reverb send,
 *  a tempo-synced delay send (`dly`), shared noise, and the channels' mix chains (see chainOf). root: the rig as made, for a note's copy (export, pan); `bus`: the copy has its own buses (see renderWav) */
type Rig = { c: BaseAudioContext; out: GainNode; pump: GainNode; duck: GainNode; verb: GainNode; dly: GainNode; delay: DelayNode; fb: GainNode; steps: number; bpm: number; noise: AudioBuffer; chains: Map<string, Chain>; root: Rig; mst?: string; bus?: true };
const LOOK = 0.006; // a DynamicsCompressor's fixed lookahead (Blink, Gecko and WebKit): everything through one comes out this late
// The limiter: Web Audio's compressor adds makeup gain, (1 / its gain at 0 dBFS)^0.6, here +0.6 dB. DRIVE sets how loud a song gets, TRIM keeps the true peak near -1 dBTP (docs/plan-mix.md: measurements)
const DRIVE = 1.8, TRIM = 0.72;
/** the song's master stage between `out` and the speakers (`mix.master`): "limiter" (default: DRIVE in, -1 dB threshold, ratio 20, fast), "compressor" (the master before the limiter: -20 dB, ratio 12), "none" */
function master(r: Rig, kind = "limiter") {
  if (r.mst === kind) return;
  const c = r.c, k = c.createDynamicsCompressor(), [th, kn, ra, at, re] = kind === "compressor" ? [-20, 6, 12, 0.003, 0.2] : [-1, 0, 20, 0, 0.1];
  k.threshold.value = th; k.knee.value = kn; k.ratio.value = ra; k.attack.value = at; k.release.value = re;
  r.out.disconnect(); r.mst = kind;
  (kind === "none" ? [r.out, c.destination] : kind === "compressor" ? [r.out, k, c.destination] : [r.out, gain(r, DRIVE), k, gain(r, TRIM), c.destination]).reduce((x: AudioNode, y: AudioNode) => (x.connect(y), y));
}
const seeded = (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * 2 - 1; }; // mulberry32, -1..1
function rig(c: BaseAudioContext, vol: number, mix: any = {}): Rig {
  const out = c.createGain(), pump = c.createGain(), verb = c.createGain(), conv = c.createConvolver(), wet = c.createGain(), dly = c.createGain(), delay = c.createDelay(6), fb = c.createGain(), rnd = seeded(1);
  out.gain.value = vol; verb.gain.value = 1; wet.gain.value = 0.32;
  const len = Math.floor(c.sampleRate * 2.2), ir = c.createBuffer(2, len, c.sampleRate); // a soft hall: decaying stereo noise, the same in every render (so stems sum to the mix)
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = rnd() * (1 - i / len) ** 3; }
  conv.buffer = ir;
  const nb = c.createBuffer(1, c.sampleRate, c.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = rnd();
  pump.connect(out); verb.connect(conv); conv.connect(wet); wet.connect(pump);
  dly.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(out); // ponytail: plain digital repeats, not ducked; put a lowpass in the loop if they sound harsh
  const x = { c, out, pump, duck: pump, verb, dly, delay, fb, steps: 3, bpm: 0, noise: nb, chains: new Map() } as unknown as Rig; x.root = x; setMix(x, mix); return x;
}
/** apply a song's `mix` to a rig: the master stage, the delay's time (steps) and feedback; the next note retunes the delay (see tempo) */
function setMix(r: Rig, m: any = {}) { master(r, m.master); r.steps = m.delay?.time ?? 3; r.fb.gain.value = m.delay?.feedback ?? 0.35; r.bpm = 0; }
const tempo = (r: Rig, bpm: number) => { if (r.bpm !== bpm) { r.bpm = bpm; r.delay.delayTime.value = Math.min(6, (r.steps * 15) / bpm); } }; // a step is a 16th, 15 / bpm s
let ac: AudioContext | null = null, R: Rig, song: any = {};
/** Live: the song's own `mix` (master stage, delay), from every state the studio sends */
export function songMix(m: any) { song = m ?? {}; if (ac) setMix(R, song); }
/** Browsers only allow audio after a user gesture: call this from Play, Space and the speaker button. */
export function unlock() {
  if (!ac) { try { ac = new AudioContext({ sampleRate: RATE }); } catch { try { ac = new AudioContext(); } catch { return; } } R = rig(ac, sound.vol, song); loadSamples(ac, want); }
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

// Karplus-Strong string: a noise burst looped through a delay line with a 2-point average (the loss), computed in JS and cached per context and pitch.
const strings = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
const TANH = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(3 * (i / 512 - 1))); // the shaper curve: -1..1 in, soft clip out
/** a plucked string at f Hz, ~4 s (the palm mute `damp`: more loss per period, 0.6 s); returns [source, output]. The average delays half a sample, so the true period is N + 0.5 samples: the integer line is tuned by playbackRate.
 *  A panned string (pan p) is one side of a double-track: its own burst, 4 cents off, and 0–8 ms late, so two channels panned apart stay two guitars instead of summing to one in the middle. */
function string(r: Rig, f: number, damp = false, p = 0): [AudioBufferSourceNode, AudioNode] {
  const c = r.c, sr = c.sampleRate, N = Math.floor(sr / f), side = Math.sign(p), k = `${f} ${damp} ${side}`;
  let m = strings.get(c); if (!m) strings.set(c, (m = new Map()));
  let b = m.get(k);
  if (!b) {
    const g = Math.min(0.9995, 10 ** ((-3 * (N + 0.5)) / sr / (damp ? 0.2 : 3)) / Math.cos((Math.PI * f) / sr)), d = (b = c.createBuffer(1, Math.ceil(sr * (damp ? 0.6 : 4)), sr)).getChannelData(0); // g: -60 dB over 3 s (0.2 s damped), whatever the pitch; the average loses cos(πf/sr) per period at the fundamental, which g gives back (capped under 1, or the DC mode grows). ponytail: the top octave still fades within ~0.5 s
    const pick = (x: number) => ((x < 0.2 ? x / 0.2 : (1 - x) / 0.8) - 0.5) * 2; // the burst: a triangle picked at 1/5 of the string (it carries the low harmonics, which are what rings) plus noise (the bite)
    for (let i = 0; i < d.length; i++) d[i] = i <= N ? pick(i / N) + Math.random() - 0.5 : g * 0.5 * (d[i - N] + d[i - N - 1]);
    m.set(k, b);
  }
  const s = c.createBufferSource(); s.buffer = b; s.playbackRate.value = ((f * (N + 0.5)) / sr) * 2 ** ((side * 4) / 1200);
  if (!side) return [s, s];
  const d = c.createDelay(0.02); d.delayTime.value = Math.random() * 0.008; s.connect(d); return [s, d];
}
// The amp: one per channel and pan, shared by the channel's notes, so a chord distorts as one sound. A tight input (highpass 120 Hz, a push at 750 Hz),
// drive into the tanh shaper (4× oversampled), then a 4×12 cabinet: a thump at 110 Hz, a scoop at 400 Hz, presence at 2.5 kHz, a steep cut above 5 kHz.
// The channel's gain is set after the distortion (like a fader), then the pan; the reverb send stays centred. Into the channel's mix chain `x` if it has one. Returns the amp's input.
const amps = new WeakMap<BaseAudioContext, Map<string, { input: GainNode; vol: GainNode }>>();
function amp(r: Rig, ch: string, p: number, lvl: number, x?: Chain) {
  let m = amps.get(r.c); if (!m) amps.set(r.c, (m = new Map()));
  const k = `${ch} ${p} ${x?.key ?? ""}`;
  let a = m.get(k);
  if (!a) {
    const eq = (type: BiquadFilterType, f: number, q: number, db = 0) => { const b = filt(r, type, f, q); b.gain.value = db; return b; }, ws = r.c.createWaveShaper();
    ws.curve = TANH; ws.oversample = "4x"; a = { input: gain(r, 30), vol: gain(r) };
    [a.input, eq("highpass", 120, 0.7), eq("peaking", 750, 0.8, 6), ws, eq("highpass", 80, 0.7), eq("peaking", 110, 1, 4), eq("peaking", 400, 1, -5), eq("peaking", 2500, 1.2, 4),
      eq("lowpass", 5000, 0.7), eq("lowpass", 5000, 0.7), a.vol, pan(r, p), x?.input ?? r.out].reduce((x, y) => (x.connect(y), y));
    if (!x?.own) send(r, a.vol, 0.12);
    m.set(k, a);
  }
  a.vol.gain.value = 0.07 * lvl;
  return a.input;
}

// A channel's `mix`: one chain per context and channel (and settings), shared by all its notes like amp(), built once and kept for the whole render:
// EQ (highpass, lowpass, peaking bands), a compressor, then its own duck stage (the sidechain) into `out`. The reverb and delay sends are taken after the
// compressor, before the duck; `reverb` replaces the sound's own sends (`own`) and goes in mono, so it stays centred like theirs. A note's pan adds the channel's (see note()).
// Without a `mix` a channel plays straight into the rig as before (the shared pump, the sound's own reverb).
type Chain = { key: string; input: GainNode; duck: GainNode; depth: number; by?: string; own: boolean };
const PUMPED = new Set(["pluck", "bell", "marimba"]); // the one-shots that sit on the pump, next to SUSTAIN's `pumped`
const late = (m: any) => (m?.comp ? LOOK : 0); // a compressed channel plays its notes this much early, so it lands on time
function chainOf(r: Rig, ch: string, kind: string, m: any): Chain {
  const key = `${ch} ${kind} ${JSON.stringify(m)}`;
  let x = r.chains.get(key);
  if (x) return x;
  const eq = m.eq ?? {}, cp = m.comp, nodes: AudioNode[] = [gain(r)], duck = gain(r);
  if (eq.highpass) nodes.push(filt(r, "highpass", eq.highpass));
  if (eq.lowpass) nodes.push(filt(r, "lowpass", eq.lowpass));
  for (const b of eq.bands ?? []) { const f = filt(r, "peaking", b.f, b.q ?? 1); f.gain.value = b.db; nodes.push(f); }
  if (cp) { const d = r.c.createDynamicsCompressor(); d.threshold.value = cp.threshold ?? -18; d.ratio.value = cp.ratio ?? 3; d.knee.value = cp.knee ?? 6; d.attack.value = cp.attack ?? 0.01; d.release.value = cp.release ?? 0.15; nodes.push(d); }
  const post = nodes[nodes.length - 1];
  [...nodes, duck, r.out].reduce((a, b) => (a.connect(b), b));
  if (m.reverb != null) { const s = gain(r, m.reverb); s.channelCount = 1; s.channelCountMode = "explicit"; post.connect(s); s.connect(r.verb); }
  if (m.delay) { const s = gain(r, m.delay); post.connect(s); s.connect(r.dly); }
  x = { key, input: nodes[0] as GainNode, duck, depth: m.duck ?? (SUSTAIN[kind]?.pumped || PUMPED.has(kind) ? 0.72 : 0), by: m.duckBy, own: m.reverb != null };
  r.chains.set(key, x); return x;
}
/** a kick on channel ch (kit `kit`) at t: ducks the shared pump (not for `rock`) and each chain that listens: any kick but rock's by default, only its `duckBy` channel's if set */
function duckAt(r: Rig, t: number, ch: string, kit: string) {
  const dip = (g: GainNode, depth: number) => { const p = g.gain; p.cancelScheduledValues(t); p.setValueAtTime(1, t); p.linearRampToValueAtTime(1 - depth, t + 0.012); p.setTargetAtTime(1, t + 0.04, 0.09); };
  if (kit !== "rock") dip(r.root.duck, 0.72);
  for (const x of r.root.chains.values()) if (x.depth && (x.by ? x.by === ch : kit !== "rock")) dip(x.duck, x.depth);
}
/** route a note's rig into node a: live, a copy whose buses are a; an export note's own buses are rewired, so it is still cut loose when the note ends. quiet: drop its reverb sends */
function into(r: Rig, a: AudioNode, quiet = false): Rig {
  if (!r.bus) return { ...r, out: a as GainNode, pump: a as GainNode, verb: quiet ? gain(r) : r.verb };
  r.out.disconnect(); r.out.connect(a); r.pump.disconnect(); r.pump.connect(a); if (quiet) r.verb.disconnect();
  return r;
}

// Voice formants for `chop` and `growl`: F1, F2, F3 (Hz, a female voice) and a level. A note's text picks them letter by letter: the vowels a i u e o,
// y and w (glides from i and u), n and m (a hum); other letters are skipped, and a text with no vowel plays the default.
const VOWEL: Record<string, number[]> = { a: [850, 1220, 2810, 1], i: [310, 2790, 3310, 0.8], u: [370, 1300, 2670, 0.8], e: [550, 2000, 2900, 0.9], o: [500, 900, 2700, 0.9],
  y: [300, 2600, 3200, 0.6], w: [330, 800, 2500, 0.6], n: [250, 1700, 2600, 0.35], m: [250, 1100, 2500, 0.35] };
/** src through three bandpasses (Q q) at the formants of text's letters, letter i reached at t + at(i, count); F1 stays above the pitch f, as a high voice opens it. Returns the sum */
function formants(r: Rig, src: AudioNode, text: string | undefined, dflt: string, f: number, t: number, at: (i: number, n: number) => number, q: number) {
  let ls = [...(text ?? "").toLowerCase()].filter((c) => VOWEL[c]);
  if (!ls.some((c) => "aiueo".includes(c))) ls = [...dflt];
  const v = ls.map((c) => VOWEL[c]), lvl = gain(r, v[0][3]), sum = gain(r);
  [1, 0.6, 0.3].forEach((amt, k) => {
    const hz = (x: number[]) => (k ? x[k] : Math.max(x[0], f * 1.1)), bp = filt(r, "bandpass", hz(v[0]), q), g = gain(r, amt * q * 0.7);
    bp.frequency.setValueAtTime(hz(v[0]), t); v.forEach((x, i) => i && bp.frequency.linearRampToValueAtTime(hz(x), t + at(i, v.length)));
    src.connect(bp); bp.connect(g); g.connect(lvl);
  });
  lvl.gain.setValueAtTime(v[0][3], t); v.forEach((x, i) => i && lvl.gain.linearRampToValueAtTime(x[3], t + at(i, v.length))); lvl.connect(sum);
  return sum;
}

// Sustained instruments: oscillators → filter → envelope. Released by the later of the note's end and the voice's end (live),
// or at the note's end (offline).
type Sus = { make: (r: Rig, f: number, t: number, vel: number, p: number, dur: number, bpm: number, text?: string) => { oscs: AudioScheduledSourceNode[]; head: AudioNode }; peak: number; hold: number; a: number; rel: number; pumped?: boolean; wet?: number; amp?: boolean }; // amp: plays into its channel's amp
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
  epiano: {
    make: (r, f, t) => { // FM Rhodes: a 1:1 modulator whose index falls (the bite), a bright partial, tremolo and a little auto-pan, and a slow decay while held
      const car = osc(r, "sine", f), mod = osc(r, "sine", f), idx = gain(r, f * 2.5), hi = osc(r, "sine", f * 4), hg = hit(r, 0.08, t, 0.5, 0.002), dg = gain(r, 1), tr = gain(r, 0.9), lfo = osc(r, "sine", 4.5), td = gain(r, 0.1), pd = gain(r, 0.15), p = pan(r, 0);
      idx.gain.setValueAtTime(f * 2.5, t); idx.gain.exponentialRampToValueAtTime(f * 0.15, t + 0.4); mod.connect(idx); idx.connect(car.frequency);
      dg.gain.setValueAtTime(1, t); dg.gain.exponentialRampToValueAtTime(0.15, t + 5); car.connect(dg); hi.connect(hg); hg.connect(dg);
      lfo.connect(td); td.connect(tr.gain); lfo.connect(pd); pd.connect(p.pan); dg.connect(tr); tr.connect(p);
      return chain([car, mod, hi, lfo], p);
    },
    peak: 0.16, hold: 0.1, a: 0.004, rel: 0.25, wet: 0.2,
  },
  synorgan: {
    make: (r, f, t) => { // Hammond drawbars (16' 5⅓' 8' 4' 2⅔' 2'), a key click, and a rotating speaker: slow auto-pan with a swell
      const am = gain(r, 0.3), tr = gain(r, 1), lfo = osc(r, "sine", 0.8), pd = gain(r, 0.45), td = gain(r, 0.1), p = pan(r, 0), ck = r.c.createBufferSource(), hp = filt(r, "highpass", 2500), cg = hit(r, 0.25, t, 0.02, 0.001);
      const oscs = [[0.5, 0.8], [1, 1], [1.5, 0.7], [2, 0.5], [3, 0.25], [4, 0.15]].map(([m, v]) => { const o = osc(r, "sine", f * m), g = gain(r, v); o.connect(g); g.connect(am); return o; });
      ck.buffer = r.noise; ck.connect(hp); hp.connect(cg); cg.connect(p); ck.start(t); ck.stop(t + 0.03);
      lfo.connect(pd); pd.connect(p.pan); lfo.connect(td); td.connect(tr.gain); am.connect(tr); tr.connect(p);
      return chain([...oscs, lfo], p);
    },
    peak: 0.14, hold: 0.14, a: 0.008, rel: 0.06, wet: 0.15,
  },
  chip: {
    make: (r, f, t) => { // an 8-bit lead with a little delayed vibrato
      const o = osc(r, "square", f), lfo = osc(r, "sine", 6), depth = gain(r, 0), lp = filt(r, "lowpass", 5200);
      depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(18, t + 0.25); lfo.connect(depth); depth.connect(o.detune); o.connect(lp);
      return chain([o, lfo], lp);
    },
    peak: 0.05, hold: 0.04, a: 0.006, rel: 0.08, wet: 0.2,
  },
  // clean electric guitar: the string through a highpass (DC) and a lowpass (tone), mixed with a chorus (a 6 ms delay swept by a slow LFO)
  eguitar: {
    make: (r, f, t, vel, p) => {
      const [s, o] = string(r, f, false, p), hp = filt(r, "highpass", 80), lp = filt(r, "lowpass", 5000), mix = gain(r, 0.7), d = r.c.createDelay(0.02), lfo = osc(r, "sine", 0.6), ld = gain(r, 0.002);
      d.delayTime.value = 0.006; lfo.connect(ld); ld.connect(d.delayTime); o.connect(hp); hp.connect(lp); lp.connect(mix); lp.connect(d); d.connect(mix);
      return chain([s, lfo], mix);
    },
    peak: 0.17, hold: 0.11, a: 0.003, rel: 0.12, wet: 0.2,
  },
  // distorted guitar: the string into its channel's amp (see amp()), which keeps the decaying string at level, so it rings for the note. vel < 0.4 is a palm mute: the damped string, darkened before the amp
  distguitar: {
    make: (r, f, t, vel, p) => {
      const pm = vel < 0.4, [s, o] = string(r, f, pm, p);
      if (!pm) return chain([s], o);
      const lp = filt(r, "lowpass", 1000); o.connect(lp); return chain([s], lp);
    },
    peak: 1, hold: 1, a: 0.003, rel: 0.05, amp: true,
  },
  // picked bass: saw + square through a lowpass that closes from 1–3 kHz (vel brightens the pick) to 600 Hz in 150 ms, then a little saturation
  ebass: {
    make: (r, f, t, vel) => {
      const a = osc(r, "sawtooth", f), b = osc(r, "square", f), ga = gain(r, 0.6), gb = gain(r, 0.4), lp = filt(r, "lowpass", 600, 1), pre = gain(r, 0.5), ws = r.c.createWaveShaper();
      lp.frequency.setValueAtTime(1000 + 2000 * vel, t); lp.frequency.exponentialRampToValueAtTime(600, t + 0.15); ws.curve = TANH;
      a.connect(ga); b.connect(gb); ga.connect(lp); gb.connect(lp); lp.connect(pre); pre.connect(ws);
      return chain([a, b], ws);
    },
    peak: 0.065, hold: 0.05, a: 0.004, rel: 0.08,
  },
  // steel-string acoustic: the string, bright (vel opens the lowpass from 5 to 11 kHz), through a body: peaks of +4 dB at 100 Hz and +3 dB at 200 Hz
  guitar: {
    make: (r, f, t, vel, p) => {
      const [s, o] = string(r, f, false, p), body = [[100, 4], [200, 3]].map(([fr, db]) => { const b = filt(r, "peaking", fr, 1); b.gain.value = db; return b; });
      return chain([s], [o, filt(r, "highpass", 70), filt(r, "lowpass", 5000 + 6000 * vel), ...body].reduce((x, y) => (x.connect(y), y)));
    },
    peak: 0.17, hold: 0.11, a: 0.003, rel: 0.15, wet: 0.12,
  },
  // warm pad: three saws ±12 cents, a lowpass that opens from ~2 to ~6 times the pitch (at least 300 to 1800 Hz) over 2.5 s; slow attack, long release, a lot of reverb. Not pumped
  pad: {
    make: (r, f, t) => {
      const lp = filt(r, "lowpass", Math.max(300, f * 2)), oscs = [-12, 0, 12].map((d, i) => { const o = osc(r, "sawtooth", f, d), p = pan(r, (i - 1) * 0.4); o.connect(p); p.connect(lp); return o; });
      lp.frequency.setValueAtTime(Math.max(300, f * 2), t); lp.frequency.exponentialRampToValueAtTime(Math.max(1800, f * 6), t + 2.5);
      return chain(oscs, lp);
    },
    peak: 0.105, hold: 0.09, a: 0.6, rel: 1.2, wet: 0.5,
  },
  // riser: looped noise through a bandpass centred on the key that rises an octave, while it swells in from silence, over the note's length (dur; ~1 s without one). The note ends at its loudest, like a reverse cymbal
  noise: {
    make: (r, f, t, vel, p, dur) => {
      const d = (dur || 1) * 0.92, s = r.c.createBufferSource(), bp = filt(r, "bandpass", f, 1.2), sw = gain(r, 0.003);
      s.buffer = r.noise; s.loop = true; bp.frequency.setValueAtTime(f, t); bp.frequency.exponentialRampToValueAtTime(f * 2, t + d); sw.gain.setValueAtTime(0.003, t); sw.gain.exponentialRampToValueAtTime(1, t + d);
      s.connect(bp); bp.connect(sw);
      return chain([s], sw);
    },
    peak: 2.6, hold: 2.6, a: 0.02, rel: 0.08, wet: 0.2,
  },
  // synth choir "ah": a saw through three vowel bandpasses (800 / 1150 / 2900 Hz, each weaker than the last) with vibrato that fades in; slow attack, long release, reverb. Not pumped
  synchoir: {
    make: (r, f, t) => {
      const o = osc(r, "sawtooth", f), lfo = osc(r, "sine", 5.5), depth = gain(r, 0), sum = gain(r);
      depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(15, t + 0.6); lfo.connect(depth); depth.connect(o.detune);
      [[800, 1], [1150, 0.5], [2900, 0.25]].forEach(([fr, v]) => { const bp = filt(r, "bandpass", fr, 6), g = gain(r, v * 3); o.connect(bp); bp.connect(g); g.connect(sum); });
      return chain([o, lfo], sum);
    },
    peak: 0.1, hold: 0.09, a: 0.25, rel: 0.7, wet: 0.45,
  },
  // DnB bass: two saws ±12 cents through a lowpass that drifts (0.3 Hz LFO, 150-850 Hz), pumped by the kick
  reese: {
    make: (r, f, t) => {
      const lp = filt(r, "lowpass", 500, 1), lfo = osc(r, "sine", 0.3), ld = gain(r, 350), oscs = [-12, 12].map((d) => { const o = osc(r, "sawtooth", f, d); o.connect(lp); return o; });
      lfo.connect(ld); ld.connect(lp.frequency);
      return chain([...oscs, lfo], lp);
    },
    peak: 0.1, hold: 0.09, a: 0.01, rel: 0.1, pumped: true,
  },
  // 303: a saw through a resonant lowpass (Q 12) that drops from 2.5 kHz to 300 Hz on each note
  acid: {
    make: (r, f, t) => {
      const o = osc(r, "sawtooth", f), lp = filt(r, "lowpass", 300, 12);
      lp.frequency.setValueAtTime(2500, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.2); o.connect(lp);
      return chain([o], lp);
    },
    peak: 0.06, hold: 0.05, a: 0.003, rel: 0.06,
  },
  // dubstep bass: a saw through a lowpass swept (100-1100 Hz) by an LFO in 8th notes at the song's tempo, pumped
  wobble: {
    make: (r, f, t, vel, p, dur, bpm) => {
      const o = osc(r, "sawtooth", f), lp = filt(r, "lowpass", 600, 5), lfo = osc(r, "sine", (bpm / 60) * 2), ld = gain(r, 500);
      lfo.connect(ld); ld.connect(lp.frequency); o.connect(lp);
      return chain([o, lfo], lp);
    },
    peak: 0.1, hold: 0.09, a: 0.01, rel: 0.1, pumped: true,
  },
  // 808: a sine at the key that drops from +12 semitones in 30 ms, soft saturation; rings for the note
  "808": {
    make: (r, f, t) => {
      const o = osc(r, "sine", f), pre = gain(r, 0.35), ws = r.c.createWaveShaper();
      o.frequency.setValueAtTime(f * 2, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.03); ws.curve = TANH; o.connect(pre); pre.connect(ws);
      return chain([o], ws);
    },
    peak: 0.1, hold: 0.06, a: 0.003, rel: 0.15,
  },
  // vocal chop: a buzz (a lowpassed saw) and a little breath through the formants of the note's text, a letter every 60 ms ("nya" is n → y → a in 0.12 s, then holds the a;
  // default "a"). Fast in, fast out, so the note's length gates it
  chop: {
    make: (r, f, t, vel, p, dur, bpm, text) => {
      const o = osc(r, "sawtooth", f), lp = filt(r, "lowpass", 5000), n = r.c.createBufferSource(), ng = gain(r, 0.06), src = gain(r);
      n.buffer = r.noise; n.loop = true; o.connect(lp); lp.connect(src); n.connect(ng); ng.connect(src);
      return chain([o, n], formants(r, src, text, "a", f, t, (i) => i * 0.06, 4));
    },
    peak: 0.1, hold: 0.09, a: 0.005, rel: 0.04, wet: 0.2,
  },
  // kawaii growl: two detuned saws, driven, through formants that move across the note from letter to letter of its text (default "wow": u → o → u),
  // over a clean sine at the key for weight. Pumped
  growl: {
    make: (r, f, t, vel, p, dur, bpm, text) => {
      const pre = gain(r, 0.6), ws = r.c.createWaveShaper(), sub = osc(r, "sine", f), sg = gain(r, 0.5), sum = gain(r), oscs = [-7, 7].map((d) => { const o = osc(r, "sawtooth", f, d); o.connect(pre); return o; });
      ws.curve = TANH; pre.connect(ws); sub.connect(sg); sg.connect(sum);
      formants(r, ws, text, "wow", f, t, (i, n) => ((dur || 0.3) * 0.85 * i) / (n - 1), 6).connect(sum);
      return chain([...oscs, sub], sum);
    },
    peak: 0.1, hold: 0.09, a: 0.005, rel: 0.08, pumped: true,
  },
  // brass lead: a saw whose lowpass opens from 400 Hz to 3 kHz over 80 ms
  brass: {
    make: (r, f, t) => {
      const o = osc(r, "sawtooth", f), lp = filt(r, "lowpass", 400);
      lp.frequency.setValueAtTime(400, t); lp.frequency.exponentialRampToValueAtTime(3000, t + 0.08); o.connect(lp);
      return chain([o], lp);
    },
    peak: 0.1, hold: 0.08, a: 0.02, rel: 0.12, wet: 0.2,
  },
  // whistle (was the synth flute): a sine with bandpassed breath noise (at twice the pitch) and vibrato that comes in after 0.3 s
  whistle: {
    make: (r, f, t) => {
      const o = osc(r, "sine", f), lfo = osc(r, "sine", 5), depth = gain(r, 0), n = r.c.createBufferSource(), bp = filt(r, "bandpass", f * 2, 2), ng = gain(r, 0.3), sum = gain(r);
      depth.gain.setValueAtTime(0, t + 0.2); depth.gain.linearRampToValueAtTime(14, t + 0.5); lfo.connect(depth); depth.connect(o.detune);
      n.buffer = r.noise; n.loop = true; n.connect(bp); bp.connect(ng); ng.connect(sum); o.connect(sum);
      return chain([o, lfo, n], sum);
    },
    peak: 0.09, hold: 0.07, a: 0.05, rel: 0.15, wet: 0.25,
  },
};
/** start a sustained tone at t; returns its gain and sources so the caller can release it */
function sustain(r: Rig, kind: string, key: number, t: number, lvl: number, vel: number, p = 0, dur = 0, bpm = 120, text?: string) {
  const s = SUSTAIN[kind] ?? SUSTAIN.triangle, { oscs, head } = s.make(r, hz(key), t, vel, p, dur, bpm, text), g = gain(r, 0.0001), h = t + Math.max(0.35, s.a + 0.1); // the hold point comes after the peak, even for a slow attack
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.peak * lvl), t + s.a); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, s.hold * lvl), h);
  head.connect(g); g.connect(s.pumped ? r.pump : r.out); if (s.wet) send(r, g, s.wet);
  oscs.forEach((x) => x.start(t));
  return { g, oscs, rel: s.rel, hold: [h, Math.max(0.0001, s.hold * lvl)] as [number, number] };
}
// Sample buffers, cached per sample rate (not per context): a decoded AudioBuffer plays in any context of that rate. A failed download stays missing until reload (ponytail: no retry).
const bank = new Map<number, Map<string, { b?: AudioBuffer; p?: Promise<void> }>>();
const sampleName = (kind: string, root: number, soft: boolean) => `${kind}/${root}${soft ? "-p" : ""}`;
/** the entry for file f at c's rate: starts the download + decode if nobody has (also the safety net for a note whose file wasn't preloaded: silent once, then it plays) */
function fetchSample(c: BaseAudioContext, f: string) {
  let m = bank.get(c.sampleRate); if (!m) bank.set(c.sampleRate, (m = new Map()));
  if (!m.has(f)) { const e: { b?: AudioBuffer; p?: Promise<void> } = {}; m.set(f, e); e.p = fetch(`/ui/samples/${f}.mp3`, { cache: "no-store" }).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then((a) => c.decodeAudioData(a)).then((b) => { e.b = b; }).catch(() => {}); }
  return m.get(f)!;
}
/** load these files on c; resolves to the ones that failed */
async function loadSamples(c: BaseAudioContext, files: Iterable<string>) {
  const es = [...new Set(files)].map((f) => [f, fetchSample(c, f)] as const);
  await Promise.all(es.map(([, e]) => e.p));
  return es.filter(([, e]) => !e.b).map(([f]) => f);
}
/** a sampled sound's key folded into range, and the nearest recorded root */
function nearest(s: (typeof SAMPLED)[string], key: number) {
  const lo = s.roots[0], hi = s.roots[s.roots.length - 1];
  while (key < lo - 3) key += 12; while (key > hi + 3) key -= 12; // the edge roots may pitch 3 semitones outward (piano 106-108); beyond that, fold by octaves into the range
  return [key, s.roots.reduce((a, b) => (Math.abs(b - key) < Math.abs(a - key) ? b : a))] as const;
}
/** the one place that decides which sample file a note plays (playing and preloading both ask): a sampled sound's nearest root (its `dead` sound's under vel 0.4),
 *  a kit's cymbal, or a shout's word (from the note's text, default "hey"); soft (-p) under vel 0.4. undefined: no file */
function fileOf(kind: string, key: number, vel: number, text?: string): string | undefined {
  const s = SAMPLED[kind], soft = vel < 0.4;
  if (s) return s.dead && soft ? sampleName(s.dead, nearest(s, key)[1], false) : sampleName(kind, nearest(s, key)[1], soft && s.soft !== false);
  if (kind === "shout") { const w = (text ?? "").toLowerCase().replace(/[^a-z]/g, ""); return `shout/${WORDS.includes(w) ? w : "hey"}`; }
  const f = KITS.includes(kind) ? CYMBAL[key] : undefined;
  return f && (soft ? `${f}-p` : f);
}
let want = new Set<string>();
/** Live: the project's sample files, from every note of every pattern (a step note is key 60, an unset vel 0.5). Loads now, or once Play unlocks the audio. */
export function preload(p: any) {
  const kind = new Map<string, string>((p?.channels ?? []).map((c: any) => [c.id, kindOf(c.generator?.plugin ?? "script", c.sound)])), fs = new Set<string>();
  const add = (ch: string, key = 60, vel = 0.5, text?: string) => { const f = fileOf(kind.get(ch) ?? "", key, vel, text); if (f) fs.add(f); };
  for (const pat of p?.patterns ?? []) {
    for (const [ch, steps] of Object.entries<any>(pat.steps ?? {})) if (steps.some(Boolean)) add(ch);
    for (const [ch, ns] of Object.entries<any>(pat.notes ?? {})) for (const n of ns) add(ch, n.key, n.vel, n.text);
  }
  want = fs; if (ac) loadSamples(ac, want);
}
/** one sampled note: the nearest recorded root, repitched; null if its buffer isn't loaded (yet). `dur`: the note's seconds (0 if unknown), for `choke` */
function sampled(r: Rig, kind: string, key: number, t: number, lvl: number, vel: number, p = 0, dur = 0) {
  const s = SAMPLED[kind], [k, root] = nearest(s, key), b = fetchSample(r.c, fileOf(kind, key, vel)!).b, dead = s.dead && vel < 0.4;
  if (!b) return null;
  const src = r.c.createBufferSource(), g = gain(r, 0.0001), oscs: AudioScheduledSourceNode[] = [src];
  const v = Math.max(0.0002, (dead ? SAMPLED[s.dead!].peak * 1.6 : s.peak) * lvl * (0.5 + vel)), a = Math.max(0.005, (s.swell ?? 0) * (1 - vel)); // vel 0.5 is unity; a dead note (vel < 0.4) still sounds at about mf
  src.buffer = b; src.playbackRate.value = 2 ** ((k - root + (s.takes ? Math.sign(p) * 0.04 : 0)) / 12); if (s.loop) { src.loop = true; [src.loopStart, src.loopEnd] = s.loop; }
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + a);
  const decay = dead ? 0.015 : s.choke && dur && dur < 0.25 ? s.choke : 0; // a decaying note has no level to hold, so release() holds whatever it has reached (cancelAndHoldAtTime)
  if (decay) g.gain.setTargetAtTime(0.0001, t + a, decay);
  if (s.leslie) { // the rotor: one LFO moves the level ±10% and the pan ±0.45, like `synorgan`
    const lfo = osc(r, "sine", 0.8), td = gain(r, 0.1), pd = gain(r, 0.45), tr = gain(r, 0.9), pn = pan(r, 0);
    lfo.connect(td); td.connect(tr.gain); lfo.connect(pd); pd.connect(pn.pan); src.connect(tr); tr.connect(pn); pn.connect(g); lfo.start(t); oscs.push(lfo);
    if (vel >= 0.7) { const pc = osc(r, "sine", hz(key) * 3), pg = hit(r, 0.35, t, 0.45, 0.002); pc.connect(pg); pg.connect(tr); pc.start(t); pc.stop(t + 0.5); }
  } else src.connect(g);
  if (s.wet) send(r, g, s.wet);
  // ponytail: the same recording, detuned and delayed; real second takes if it still sounds narrow
  if (s.takes && p) { const d = r.c.createDelay(0.02); d.delayTime.value = Math.random() * 0.008; g.connect(d); d.connect(r.out); } else g.connect(r.out);
  src.start(t);
  return { g, oscs, rel: s.rel, hold: decay ? undefined : [t + a, v] as [number, number] };
}
/** release at `at` (≥ now): hold whatever the envelope is doing at that moment, then fade. Offline, `at` is far ahead of the attack.
 *  `hold` is the envelope's last event [time, level]: past it, cancelAndHoldAtTime adds no event, so without it the fade would start back at that event and run across the whole note. */
type Voice = { g: GainNode; oscs: AudioScheduledSourceNode[]; rel: number; hold?: [number, number] };
const release = (v: Voice, now: number, at: number) => {
  const g: any = v.g.gain;
  if (v.hold && at >= v.hold[0]) { g.cancelScheduledValues(at); g.setValueAtTime(v.hold[1], at); }
  else if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at);
  else { g.cancelScheduledValues(Math.max(now, at)); g.setValueAtTime(Math.max(0.0001, g.value), Math.max(now, at)); } // ponytail: older engines jump to the current level
  g.exponentialRampToValueAtTime(0.0001, at + v.rel); v.oscs.forEach((x) => x.stop(at + v.rel + 0.05));
};
/** play one note of any instrument at time t on rig r; sustained and sampled kinds (and the brushes swirl) are returned for release, one-shots handle themselves. vel only matters to sampled ones, the ride and `guitar`; `dur` (the note's seconds, 0 if unknown) only to `noise`, `growl` and a `choke`; `bpm` only to `wobble`, `text` only to `chop`, `growl` and `shout` */
/** `mix`: the channel's mix settings (into its chain; its pan adds to the note's, clamped) */
function note(r: Rig, kind: string, key: number, t: number, lvl: number, vel = 0.5, p = 0, ch = "", dur = 0, bpm = 120, text?: string, mix?: any) {
  tempo(r.root, bpm);
  const x = mix ? chainOf(r.root, ch, kind, mix) : undefined;
  if (x) { r = into(r, x.input, x.own); p = Math.max(-1, Math.min(1, p + (mix.pan ?? 0))); }
  if (SUSTAIN[kind]?.amp) { // into the channel's amp, which sets the level and pan
    r = into(r, amp(r.root, ch, p, lvl, x));
    return sustain(r, kind, key, t, 1, vel, p);
  }
  if (p) { const o = pan(r, p), q = pan(r, p); o.connect(r.out); q.connect(r.pump); r = { ...r, out: o, pump: q }; } // a panned note plays into its own panners (the reverb send stays centred; `duck` stays the real pump)
  if (KITS.includes(kind)) return drum(r, key, t, lvl, vel, kind, ch);
  if (kind === "shout") { shout(r, fileOf(kind, key, vel, text)!, t, lvl, vel); return null; }
  if (ONESHOT.has(kind)) { (kind === "pluck" ? pluck : kind === "marimba" ? marimba : bell)(r, hz(key), t, lvl); return null; }
  if (SAMPLED[kind]) return sampled(r, kind, key, t, lvl, vel, p, dur);
  return sustain(r, kind, key, t, lvl, vel, p, dur, bpm, text);
}

const tones = new Map<string, Voice & { until: number }>();
export type VoiceSound = { sound?: string; gain?: number; dur?: number; vel?: number; pan?: number; ch?: string; bpm?: number; text?: string; mix?: any }; // mix: the channel's
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
  const t = Math.max(ac!.currentTime, when(at) - late(o.mix)), v = note(R, kind, key ?? 60, t, o.gain ?? 1, o.vel, o.pan, o.ch, o.dur, o.bpm, o.text, o.mix);
  stats.started++;
  if (!v) { stats.stopped++; if (KITS.includes(kind) && (key === 35 || key === 36)) stats.kicks++; return; }
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
  const lp = filt(r, "lowpass", 6000, 2), g = hit(r, 0.16 * lvl, t, 0.5);
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
/** one-shot marimba: a sine plus 4× and 10× partials (skipped past 20 kHz) that fade much faster than the fundamental: a wooden knock, then the tone */
function marimba(r: Rig, f: number, t: number, lvl: number) {
  [[1, 0.3, 0.8], [4, 0.15, 0.2], [10, 0.06, 0.05]].forEach(([m, peak, dur]) => {
    if (f * m > 20000) return;
    const o = osc(r, "sine", f * m), g = hit(r, peak * lvl, t, dur, 0.002); o.connect(g); g.connect(r.pump); send(r, g, 0.25); o.start(t); o.stop(t + dur + 0.05);
  });
}
/** a sampled cymbal (file `ride/51`, `cymbals/49-p`…, from fileOf), rung out whole; skipped until its buffer has loaded. ponytail: no choke, so 16th-note ride patterns pile up */
function cymbal(r: Rig, f: string, t: number, lvl: number, vel: number) {
  const b = fetchSample(r.c, f).b;
  if (!b) return;
  const src = r.c.createBufferSource(), g = gain(r, 1.4 * lvl * (0.5 + vel)); // the files are loudness-matched (scripts/samples.mjs), not peak-normalized
  src.buffer = b; src.connect(g); g.connect(r.out); send(r, g, 0.15); src.start(t);
}
/** a shout (file shout/<word>, from fileOf) layered three times, ±25 cents, 0-25 ms apart and spread across the stereo field, so a single voice reads as a gang. The key doesn't matter */
function shout(r: Rig, f: string, t: number, lvl: number, vel: number) {
  const b = fetchSample(r.c, f).b;
  if (!b) return;
  for (const [c, d, p] of [[-25, 0, -0.5], [0, 0.012, 0], [25, 0.025, 0.5]]) {
    const src = r.c.createBufferSource(), g = gain(r, 0.5 * lvl * (0.5 + vel)), pn = pan(r, p); // the files are loudness-matched (scripts/samples.mjs)
    src.buffer = b; src.detune.value = c; src.connect(g); g.connect(pn); pn.connect(r.out); send(r, g, 0.15); src.start(t + d);
  }
}
const TOMS: Record<number, number> = { 41: 82, 43: 102, 45: 125, 47: 152, 48: 185, 50: 225 }; // low floor tom up to high tom, Hz
/** General MIDI-ish kit: 35/36 kick, 37 side stick, 38/40 snare, 39 clap, 41-50 toms, 42/44 closed hat, 46 open hat, 49/57 crash, 52 china, 51/59 ride bow, 53 ride bell, 55 splash,
 *  54 tambourine, 56 cowbell, 70 maracas, 75 claves; anything else is a rim click. `brushes` is a soft round kick, 38 a slap, and 40 a swirl that swells
 *  in and lasts until released (the returned voice); `rock` is a lower, punchier kick that doesn't duck the pump, and a snare with body and a long bright tail; the rest is shared.
 *  A closed hat (42/44) chokes the open hat (46) before it. */
const openHat = new WeakMap<BaseAudioContext, GainNode>(); // the last open hat's gain per context (a note's rig is a copy, so not on the rig)
function drum(r: Rig, key: number, t: number, lvl: number, vel = 0.5, kit = "drums", ch = "") {
  const soft = kit === "brushes", rock = kit === "rock", n = (f: BiquadFilterNode, peak: number, dur: number, at = t, wet = 0, a = 0.001) => {
    const s = r.c.createBufferSource(), g = hit(r, peak * lvl, at, dur, a); s.buffer = r.noise; s.connect(f); f.connect(g); g.connect(r.out); if (wet) send(r, g, wet); s.start(at); s.stop(at + dur + 0.02); return g;
  }, tone = (type: OscillatorType, f: number, peak: number, dur: number) => { const o = osc(r, type, f), g = hit(r, peak * lvl, t, dur, 0.001); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + dur + 0.03); };
  if (key === 35 || key === 36) {
    const o = osc(r, "sine", rock ? 120 : 160), g = hit(r, (soft ? 0.55 : 0.9) * lvl, t, rock ? 0.3 : 0.38, 0.002);
    o.frequency.setValueAtTime(rock ? 120 : 160, t); o.frequency.exponentialRampToValueAtTime(rock ? 50 : 42, t + (rock ? 0.07 : 0.13)); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + 0.42);
    if (!soft) n(filt(r, "highpass", rock ? 2500 : 3000), rock ? 0.25 : 0.12, 0.012); // the click of the beater
    duckAt(r, t, ch, kit);
  } else if (soft && key === 40) { // the swirl: bandpassed noise, a slow wobble in the band, swelling in
    const s = r.c.createBufferSource(), bp = filt(r, "bandpass", 2400, 0.5), lfo = osc(r, "sine", 1.7), ld = gain(r, 700), g = gain(r, 0.0001);
    s.buffer = r.noise; s.loop = true; lfo.connect(ld); ld.connect(bp.frequency); s.connect(bp); bp.connect(g); g.connect(r.out); send(r, g, 0.2);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.3 * lvl), t + 0.3);
    s.start(t); lfo.start(t);
    return { g, oscs: [s, lfo] as AudioScheduledSourceNode[], rel: 0.15, hold: [t + 0.3, Math.max(0.0002, 0.3 * lvl)] as [number, number] };
  } else if (key === 38 || key === 40) {
    if (soft) { n(filt(r, "bandpass", 1100, 0.6), 0.4, 0.2, t, 0.2, 0.008); n(filt(r, "highpass", 4500), 0.1, 0.15, t + 0.02, 0.1, 0.03); } // the slap, then the swish
    else if (rock) { tone("triangle", 180, 0.3, 0.14); tone("triangle", 310, 0.2, 0.1); n(filt(r, "highpass", 2200), 0.5, 0.32, t, 0.45); } // two tones for the body, a long bright tail in the room
    else {
      n(filt(r, "bandpass", 1800, 0.8), 0.5, 0.19, t, 0.2);
      tone("triangle", 190, 0.28, 0.11);
    }
  } else if (key === 37) { tone("triangle", 330, 0.25, 0.04); n(filt(r, "bandpass", 2000, 1.5), 0.3, 0.03); }
  else if (key === 39) for (const d of [0, 0.011, 0.022]) n(filt(r, "bandpass", 1300, 1.2), 0.45, d === 0.022 ? 0.16 : 0.012, t + d, d === 0.022 ? 0.3 : 0);
  else if (TOMS[key]) { // a sine with a fast pitch drop plus a little noise; the lower the tom, the longer it rings
    const f = TOMS[key], o = osc(r, "sine", f * 1.7), g = hit(r, 0.6 * lvl, t, 0.5 - f / 800, 0.002);
    o.frequency.setValueAtTime(f * 1.7, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.07); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + 0.5);
    n(filt(r, "bandpass", f * 6, 1), 0.12, 0.04);
  }
  else if (key === 42 || key === 44) { const o = openHat.get(r.c); if (o) { release({ g: o, oscs: [], rel: 0.02 }, t, t); openHat.delete(r.c); } n(filt(r, "highpass", 7500), soft ? 0.15 : 0.22, 0.05); } // choke the open hat
  else if (key === 46) openHat.set(r.c, n(filt(r, "highpass", 6500), soft ? 0.14 : 0.2, 0.3));
  else if (CYMBAL[key]) cymbal(r, fileOf(kit, key, vel)!, t, lvl, vel);
  else if (key === 54) n(filt(r, "bandpass", 8500, 0.9), 0.22, 0.14, t, 0.1);
  else if (key === 56) { // 808 cowbell: two squares, bandpassed, short
    const b = filt(r, "bandpass", 700, 1), g = hit(r, 0.12 * lvl, t, 0.3, 0.001); b.connect(g); g.connect(r.out);
    for (const f of [540, 800]) { const o = osc(r, "square", f); o.connect(b); o.start(t); o.stop(t + 0.33); }
  }
  else if (key === 70) n(filt(r, "bandpass", 6500, 1), 0.2, 0.06, t, 0, 0.012);
  else if (key === 75) tone("sine", 2400, 0.3, 0.06);
  else n(filt(r, "bandpass", 2600, 3), 0.25, 0.03);
  return null;
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
export type Score = { bpm: number; end: number; notes: { ch: string; key: number; start: number; len: number; vel?: number; pan?: number; text?: string }[]; channels: { id: string; plugin?: string; sound?: string; gain?: number; mix?: any }[]; mix?: any };
/** Render the score with the same instruments and return a 16-bit stereo WAV. Ticks: 96 per beat, tick 0 at the file's first sample. A 2 s tail lets reverb ring out.
 *  stem: render only that channel, pre-master (no master stage), with its own reverb and delay, still ducked by the other channels' kicks (they play silently) */
export async function renderWav(s: Score, rate = RATE, stem?: string): Promise<ArrayBuffer> {
  // A compressor's lookahead delays what goes through it by `pre` frames: every note is scheduled `pre` late, so a compressed channel can start that much early
  // (see late()), and the file starts `pre` in, plus `pre` more for the master stage's own
  const m = stem ? { ...s.mix, master: "none" } : s.mix ?? {}, pre = Math.floor(LOOK * rate), lead = pre / rate, skip = pre + (m.master === "none" ? 0 : pre);
  const sec = (ticks: number) => (ticks * 60) / s.bpm / 96, length = Math.ceil((sec(s.end) + 2) * rate) + skip;
  const c = new OfflineAudioContext(2, length, rate), r = rig(c, 0.8, m), chs = new Map(s.channels.map((x) => [x.id, x]));
  const kindAt = (id: string) => kindOf(chs.get(id)?.plugin ?? "script", chs.get(id)?.sound), time = (n: Score["notes"][number]) => sec(n.start) + lead - late(chs.get(n.ch)?.mix);
  const kick = (n: Score["notes"][number]) => KITS.includes(kindAt(n.ch)) && (n.key === 35 || n.key === 36);
  const notes = s.notes.filter((n) => !stem || n.ch === stem || kick(n)).sort((a, b) => time(a) - time(b)), plays = (n: Score["notes"][number]) => !stem || n.ch === stem; // time order: each kick's pump automation cancels what follows it
  const miss = await loadSamples(c, notes.filter(plays).flatMap((n) => fileOf(kindAt(n.ch), n.key, n.vel ?? 0.5, n.text) ?? [])); // decode before rendering starts (a no-op for the files the live tab has)
  if (miss.length) throw new Error(`sample files failed to load: ${miss.slice(0, 3).join(", ")}${miss.length > 3 ? ` and ${miss.length - 3} more` : ""}`);
  tempo(r, s.bpm);
  for (const id of new Set(notes.filter(plays).map((n) => n.ch))) if (chs.get(id)?.mix) chainOf(r, id, kindAt(id), chs.get(id)!.mix); // every chain up front, so the first kick already ducks it
  // Speed: every node wired to the output is processed in every block, sounding or not, so notes are made just ahead of the render (at a
  // suspend each second) and each plays into its own bus, cut loose once its sources have ended (offline, nothing garbage-collects them). The chains stay.
  const made: AudioScheduledSourceNode[] = [], ended: GainNode[][] = [];
  for (const k of ["createOscillator", "createBufferSource"] as const) { const f: any = c[k].bind(c); (c as any)[k] = () => { const x = f(); made.push(x); return x; }; }
  let i = 0;
  const upTo = (until: number) => { for (; i < notes.length && time(notes[i]) < until; i++) {
    const n = notes[i], t = time(n);
    if (!plays(n)) { duckAt(r, t, n.ch, kindAt(n.ch)); continue; }
    const b: Rig = { ...r, out: gain(r), pump: gain(r), verb: gain(r), bus: true }, bus = [b.out, b.pump, b.verb];
    b.out.connect(r.out); b.pump.connect(r.pump); b.verb.connect(r.verb); made.length = 0;
    const v = note(b, kindAt(n.ch), n.key, t, chs.get(n.ch)?.gain ?? 1, n.vel, n.pan, n.ch, sec(n.len), s.bpm, n.text, chs.get(n.ch)?.mix);
    if (v) release(v, t, t + Math.max(0.05, sec(n.len) * 0.92));
    let left = made.length;
    if (!left) ended.push(bus); else for (const x of made) x.onended = () => { if (--left === 0) ended.push(bus); };
  } };
  const lazy = typeof (c as any).suspend === "function"; // Gecko has no OfflineAudioContext.suspend(): there every note is made up front (slow on long songs)
  upTo(lazy ? 2 : Infinity);
  if (lazy) for (let at = 1; at < length / rate; at++) c.suspend(at).then(() => { for (const bus of ended.splice(0)) bus.forEach((g) => g.disconnect()); upTo(at + 2); c.resume(); }); // 1-2 s ahead
  return wav(await c.startRendering(), skip);
}
/** AudioBuffer → 16-bit PCM WAV bytes, minus its first `skip` frames */
function wav(b: AudioBuffer, skip = 0): ArrayBuffer {
  const chans = b.numberOfChannels, frames = b.length - skip, data = frames * chans * 2, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, chans, true);
  v.setUint32(24, b.sampleRate, true); v.setUint32(28, b.sampleRate * chans * 2, true); v.setUint16(32, chans * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, data, true);
  const cd = [...Array(chans)].map((_, i) => b.getChannelData(i));
  for (let i = skip, o = 44; i < b.length; i++) for (let ch = 0; ch < chans; ch++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, cd[ch][i])) * 0x7fff, true);
  return buf;
}
