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
export const FAMILIES: Record<string, string[]> = { lead: ["triangle", "sine", "square", "saw", "chip", "brass", "flute"], horns: ["sax", "trumpet", "trombone"], strings: ["strings", "violin", "harp"], keys: ["piano", "epiano", "organ"], bass: ["sub", "upright", "ebass", "reese", "acid", "wobble", "808"], guitar: ["eguitar", "distguitar", "guitar"], pad: ["supersaw", "pad", "choir"], mallets: ["pluck", "bell", "marimba", "vibes", "glock", "timpani"], drums: ["drums", "brushes", "rock"], fx: ["noise"] };
export const SOUNDS = Object.values(FAMILIES).flat();
const ONESHOT = new Set(["pluck", "bell", "marimba", "drums", "brushes", "rock"]); // a sound in neither this nor SAMPLED is sustained (see SUSTAIN)
const span = (a: number, b: number) => Array.from({ length: (b - a) / 3 + 1 }, (_, i) => a + 3 * i); // a recorded note every minor third
// Sampled sounds: files ui/samples/<sound>/<root>.mp3 (mf) and <root>-p.mp3 (soft; `soft: false` = mf only). The recording carries its own decay, so the envelope only
// holds it and releases at the note's end. A held sound has a `loop` [start, end] (s, the same for all its files; keep in sync with scripts/samples.mjs): each file ends at the
// loop's end with a crossfade baked in, so it loops for as long as the note. `swell`: the attack at vel 0, shrinking as vel rises (strings swell in when played soft).
const SAMPLED: Record<string, { roots: number[]; rel: number; peak: number; wet?: number; loop?: [number, number]; soft?: false; swell?: number }> = {
  piano: { roots: span(21, 105), rel: 0.3, peak: 0.4 },
  sax: { roots: span(49, 79), rel: 0.12, peak: 0.45, wet: 0.25, loop: [1, 2.2] },
  upright: { roots: span(28, 67), rel: 0.08, peak: 0.65 }, // plucked: it decays on its own
  vibes: { roots: span(48, 87), rel: 0.5, peak: 0.4, wet: 0.3 }, // a damped bar
  trombone: { roots: span(40, 70), rel: 0.12, peak: 1.4, wet: 0.25, loop: [0.5, 1.4] }, // brass is spikier than the sax, so peak-normalized files sit ~6 dB lower
  trumpet: { roots: span(52, 85), rel: 0.12, peak: 0.9, wet: 0.25, loop: [1, 3.4] },
  strings: { roots: [36, 40, 43, 47, 50, 53, 57, 60, 62, 65, 69, 72, 76, 79, 83, 86], rel: 0.4, peak: 0.5, wet: 0.35, loop: [2.5, 5], swell: 0.6 }, // cello section to 60, violas 62-69, violins from 72
  violin: { roots: [55, 57, 60, 64, 67, 69, 72, 76, 79, 81, 84, 88, 91, 93, 96], rel: 0.25, peak: 0.75, wet: 0.3, loop: [4, 6.5] }, // solo, arco with vibrato
  harp: { roots: [28, 35, 38, 41, 45, 48, 52, 55, 59, 62, 65, 69, 72, 76, 79, 83, 86, 89, 93, 95, 98, 101], rel: 0.6, peak: 0.45, wet: 0.3, soft: false },
  glock: { roots: [79, 84, 91, 96, 103, 108], rel: 0.8, peak: 0.8, wet: 0.3, soft: false },
  timpani: { roots: [41, 47, 49, 52, 55], rel: 0.5, peak: 1.2, wet: 0.2 }, // five drums, each repitched around its tuning
};
const KITS = ["drums", "brushes", "rock"], CYMBAL: Record<number, string> = { 49: "cymbals/49", 57: "cymbals/49", 52: "cymbals/52", 55: "cymbals/55", 51: "ride/51", 59: "ride/51", 53: "ride/53" }; // every kit shares the sampled cymbals: crash (49, 57), china (52), splash (55), ride bow (51, 59) and bell (53), each mf and soft (-p)
const RATE = 44100; // the sample files' rate: the live context and the export both run at it, so one decode of each file serves both (an AudioBuffer works in any context)
const BY_PLUGIN: Record<string, string> = { script: "triangle", "llm.agent": "saw", harness: "square" };

/** A sound rig on one audio context: master out (limited), a pump bus that ducks on kicks (`duck` is its gain stage, even when a note gets its own `pump`), a reverb send, shared noise. */
type Rig = { c: BaseAudioContext; out: GainNode; pump: GainNode; duck: GainNode; verb: GainNode; noise: AudioBuffer; root: Rig }; // root: the rig as made, for a note's copy (export, pan)
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
  const x = { c, out, pump, duck: pump, verb, noise: nb } as Rig; x.root = x; return x;
}
let ac: AudioContext | null = null, R: Rig;
/** Browsers only allow audio after a user gesture: call this from Play, Space and the speaker button. */
export function unlock() {
  if (!ac) { try { ac = new AudioContext({ sampleRate: RATE }); } catch { try { ac = new AudioContext(); } catch { return; } } R = rig(ac, sound.vol); loadSamples(ac, want); }
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
// The channel's gain is set after the distortion (like a fader), then the pan; the reverb send stays centred. Returns the amp's input.
const amps = new WeakMap<BaseAudioContext, Map<string, { input: GainNode; vol: GainNode }>>();
function amp(r: Rig, ch: string, p: number, lvl: number) {
  let m = amps.get(r.c); if (!m) amps.set(r.c, (m = new Map()));
  let a = m.get(`${ch} ${p}`);
  if (!a) {
    const eq = (type: BiquadFilterType, f: number, q: number, db = 0) => { const b = filt(r, type, f, q); b.gain.value = db; return b; }, ws = r.c.createWaveShaper();
    ws.curve = TANH; ws.oversample = "4x"; a = { input: gain(r, 30), vol: gain(r) };
    [a.input, eq("highpass", 120, 0.7), eq("peaking", 750, 0.8, 6), ws, eq("highpass", 80, 0.7), eq("peaking", 110, 1, 4), eq("peaking", 400, 1, -5), eq("peaking", 2500, 1.2, 4),
      eq("lowpass", 5000, 0.7), eq("lowpass", 5000, 0.7), a.vol, pan(r, p), r.out].reduce((x, y) => (x.connect(y), y));
    send(r, a.vol, 0.12); m.set(`${ch} ${p}`, a);
  }
  a.vol.gain.value = 0.07 * lvl;
  return a.input;
}

// Sustained instruments: oscillators → filter → envelope. Released by the later of the note's end and the voice's end (live),
// or at the note's end (offline).
type Sus = { make: (r: Rig, f: number, t: number, vel: number, p: number, dur: number, bpm: number) => { oscs: AudioScheduledSourceNode[]; head: AudioNode }; peak: number; hold: number; a: number; rel: number; pumped?: boolean; wet?: number; amp?: boolean }; // amp: plays into its channel's amp
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
  organ: {
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
  // choir "ah": a saw through three vowel bandpasses (800 / 1150 / 2900 Hz, each weaker than the last) with vibrato that fades in; slow attack, long release, reverb. Not pumped
  choir: {
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
  // brass lead: a saw whose lowpass opens from 400 Hz to 3 kHz over 80 ms
  brass: {
    make: (r, f, t) => {
      const o = osc(r, "sawtooth", f), lp = filt(r, "lowpass", 400);
      lp.frequency.setValueAtTime(400, t); lp.frequency.exponentialRampToValueAtTime(3000, t + 0.08); o.connect(lp);
      return chain([o], lp);
    },
    peak: 0.1, hold: 0.08, a: 0.02, rel: 0.12, wet: 0.2,
  },
  // flute: a sine with bandpassed breath noise (at twice the pitch) and vibrato that comes in after 0.3 s
  flute: {
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
function sustain(r: Rig, kind: string, key: number, t: number, lvl: number, vel: number, p = 0, dur = 0, bpm = 120) {
  const s = SUSTAIN[kind] ?? SUSTAIN.triangle, { oscs, head } = s.make(r, hz(key), t, vel, p, dur, bpm), g = gain(r, 0.0001), h = t + Math.max(0.35, s.a + 0.1); // the hold point comes after the peak, even for a slow attack
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
/** the one place that decides which sample file a note plays (playing and preloading both ask): a sampled sound's nearest root, or a kit's cymbal; soft (-p) under vel 0.4. undefined: no file */
function fileOf(kind: string, key: number, vel: number): string | undefined {
  const s = SAMPLED[kind], soft = vel < 0.4;
  if (s) return sampleName(kind, nearest(s, key)[1], soft && s.soft !== false);
  const f = KITS.includes(kind) ? CYMBAL[key] : undefined;
  return f && (soft ? `${f}-p` : f);
}
let want = new Set<string>();
/** Live: the project's sample files, from every note of every pattern (a step note is key 60, an unset vel 0.5). Loads now, or once Play unlocks the audio. */
export function preload(p: any) {
  const kind = new Map<string, string>((p?.channels ?? []).map((c: any) => [c.id, kindOf(c.generator?.plugin ?? "script", c.sound)])), fs = new Set<string>();
  const add = (ch: string, key = 60, vel = 0.5) => { const f = fileOf(kind.get(ch) ?? "", key, vel); if (f) fs.add(f); };
  for (const pat of p?.patterns ?? []) {
    for (const [ch, steps] of Object.entries<any>(pat.steps ?? {})) if (steps.some(Boolean)) add(ch);
    for (const [ch, ns] of Object.entries<any>(pat.notes ?? {})) for (const n of ns) add(ch, n.key, n.vel);
  }
  want = fs; if (ac) loadSamples(ac, want);
}
/** one sampled note: the nearest recorded root, repitched; null if its buffer isn't loaded (yet) */
function sampled(r: Rig, kind: string, key: number, t: number, lvl: number, vel: number) {
  const s = SAMPLED[kind], [k, root] = nearest(s, key), b = fetchSample(r.c, fileOf(kind, key, vel)!).b;
  if (!b) return null;
  const src = r.c.createBufferSource(), g = gain(r, 0.0001);
  const v = Math.max(0.0002, s.peak * lvl * (0.5 + vel)), a = Math.max(0.005, (s.swell ?? 0) * (1 - vel)); // vel 0.5 is unity
  src.buffer = b; src.playbackRate.value = 2 ** ((k - root) / 12); if (s.loop) { src.loop = true; [src.loopStart, src.loopEnd] = s.loop; }
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + a);
  src.connect(g); g.connect(r.out); if (s.wet) send(r, g, s.wet);
  src.start(t);
  return { g, oscs: [src] as AudioScheduledSourceNode[], rel: s.rel, hold: [t + a, v] as [number, number] };
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
/** play one note of any instrument at time t on rig r; sustained and sampled kinds (and the brushes swirl) are returned for release, one-shots handle themselves. vel only matters to sampled ones, the ride and `guitar`; `dur` (the note's seconds, 0 if unknown) only to `noise`, `bpm` only to `wobble` */
function note(r: Rig, kind: string, key: number, t: number, lvl: number, vel = 0.5, p = 0, ch = "", dur = 0, bpm = 120) {
  if (SUSTAIN[kind]?.amp) { // into the channel's amp, which sets the level and pan. An export note's own bus is rewired into it, so it is still cut loose when the note ends
    const a = amp(r.root, ch, p, lvl);
    if (r.out === r.root.out) r = { ...r, out: a }; else { r.out.disconnect(); r.out.connect(a); }
    return sustain(r, kind, key, t, 1, vel, p);
  }
  if (p) { const o = pan(r, p), q = pan(r, p); o.connect(r.out); q.connect(r.pump); r = { ...r, out: o, pump: q }; } // a panned note plays into its own panners (the reverb send stays centred; `duck` stays the real pump)
  if (KITS.includes(kind)) return drum(r, key, t, lvl, vel, kind);
  if (ONESHOT.has(kind)) { (kind === "pluck" ? pluck : kind === "marimba" ? marimba : bell)(r, hz(key), t, lvl); return null; }
  if (SAMPLED[kind]) return sampled(r, kind, key, t, lvl, vel);
  return sustain(r, kind, key, t, lvl, vel, p, dur, bpm);
}

const tones = new Map<string, Voice & { until: number }>();
export type VoiceSound = { sound?: string; gain?: number; dur?: number; vel?: number; pan?: number; ch?: string; bpm?: number };
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
  const t = when(at), v = note(R, kind, key ?? 60, t, o.gain ?? 1, o.vel, o.pan, o.ch, o.dur, o.bpm);
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
const TOMS: Record<number, number> = { 41: 82, 43: 102, 45: 125, 47: 152, 48: 185, 50: 225 }; // low floor tom up to high tom, Hz
/** General MIDI-ish kit: 35/36 kick, 37 side stick, 38/40 snare, 39 clap, 41-50 toms, 42/44 closed hat, 46 open hat, 49/57 crash, 52 china, 51/59 ride bow, 53 ride bell, 55 splash,
 *  54 tambourine, 56 cowbell, 70 maracas, 75 claves; anything else is a rim click. `brushes` is a soft round kick, 38 a slap, and 40 a swirl that swells
 *  in and lasts until released (the returned voice); `rock` is a lower, punchier kick that doesn't duck the pump, and a snare with body and a long bright tail; the rest is shared.
 *  A closed hat (42/44) chokes the open hat (46) before it. */
const openHat = new WeakMap<BaseAudioContext, GainNode>(); // the last open hat's gain per context (a note's rig is a copy, so not on the rig)
function drum(r: Rig, key: number, t: number, lvl: number, vel = 0.5, kit = "drums") {
  const soft = kit === "brushes", rock = kit === "rock", n = (f: BiquadFilterNode, peak: number, dur: number, at = t, wet = 0, a = 0.001) => {
    const s = r.c.createBufferSource(), g = hit(r, peak * lvl, at, dur, a); s.buffer = r.noise; s.connect(f); f.connect(g); g.connect(r.out); if (wet) send(r, g, wet); s.start(at); s.stop(at + dur + 0.02); return g;
  }, tone = (type: OscillatorType, f: number, peak: number, dur: number) => { const o = osc(r, type, f), g = hit(r, peak * lvl, t, dur, 0.001); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + dur + 0.03); };
  if (key === 35 || key === 36) {
    const o = osc(r, "sine", rock ? 120 : 160), g = hit(r, (soft ? 0.55 : 0.9) * lvl, t, rock ? 0.3 : 0.38, 0.002);
    o.frequency.setValueAtTime(rock ? 120 : 160, t); o.frequency.exponentialRampToValueAtTime(rock ? 50 : 42, t + (rock ? 0.07 : 0.13)); o.connect(g); g.connect(r.out); o.start(t); o.stop(t + 0.42);
    if (!soft) n(filt(r, "highpass", rock ? 2500 : 3000), rock ? 0.25 : 0.12, 0.012); // the click of the beater
    if (!rock) { const p = r.duck.gain; p.cancelScheduledValues(t); p.setValueAtTime(1, t); p.linearRampToValueAtTime(0.28, t + 0.012); p.setTargetAtTime(1, t + 0.04, 0.09); }
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
export type Score = { bpm: number; end: number; notes: { ch: string; key: number; start: number; len: number; vel?: number; pan?: number }[]; channels: { id: string; plugin?: string; sound?: string; gain?: number }[] };
/** Render the score with the same instruments and return a 16-bit stereo WAV. Ticks: 96 per beat, tick 0 at the file's first sample. A 2 s tail lets reverb ring out. */
export async function renderWav(s: Score, rate = RATE): Promise<ArrayBuffer> {
  const pre = Math.floor(0.006 * rate); // the limiter's fixed 6 ms lookahead (DynamicsCompressor in Blink, Gecko and WebKit) delays everything: render it, then cut it off
  const sec = (ticks: number) => (ticks * 60) / s.bpm / 96, length = Math.ceil((sec(s.end) + 2) * rate) + pre;
  const c = new OfflineAudioContext(2, length, rate), r = rig(c, 0.8), chs = new Map(s.channels.map((x) => [x.id, x]));
  const kindAt = (id: string) => kindOf(chs.get(id)?.plugin ?? "script", chs.get(id)?.sound);
  const miss = await loadSamples(c, s.notes.flatMap((n) => fileOf(kindAt(n.ch), n.key, n.vel ?? 0.5) ?? [])); // decode before rendering starts (a no-op for the files the live tab has)
  if (miss.length) throw new Error(`sample files failed to load: ${miss.slice(0, 3).join(", ")}${miss.length > 3 ? ` and ${miss.length - 3} more` : ""}`);
  // Speed: every node wired to the output is processed in every block, sounding or not, so notes are made just ahead of the render (at a
  // suspend each second) and each plays into its own bus, cut loose once its sources have ended (offline, nothing garbage-collects them).
  const made: AudioScheduledSourceNode[] = [], ended: GainNode[][] = [], notes = [...s.notes].sort((a, b) => a.start - b.start); // time order: each kick's pump automation cancels what follows it
  for (const k of ["createOscillator", "createBufferSource"] as const) { const f: any = c[k].bind(c); (c as any)[k] = () => { const x = f(); made.push(x); return x; }; }
  let i = 0;
  const upTo = (until: number) => { for (; i < notes.length && sec(notes[i].start) < until; i++) {
    const n = notes[i], t = sec(n.start), b = { ...r, out: gain(r), pump: gain(r), verb: gain(r) }, bus = [b.out, b.pump, b.verb];
    b.out.connect(r.out); b.pump.connect(r.pump); b.verb.connect(r.verb); made.length = 0;
    const v = note(b, kindAt(n.ch), n.key, t, chs.get(n.ch)?.gain ?? 1, n.vel, n.pan, n.ch, sec(n.len), s.bpm);
    if (v) release(v, t, t + Math.max(0.05, sec(n.len) * 0.92));
    let left = made.length;
    if (!left) ended.push(bus); else for (const x of made) x.onended = () => { if (--left === 0) ended.push(bus); };
  } };
  const lazy = typeof (c as any).suspend === "function"; // Gecko has no OfflineAudioContext.suspend(): there every note is made up front (slow on long songs)
  upTo(lazy ? 2 : Infinity);
  if (lazy) for (let at = 1; at < length / rate; at++) c.suspend(at).then(() => { for (const bus of ended.splice(0)) bus.forEach((g) => g.disconnect()); upTo(at + 2); c.resume(); }); // 1-2 s ahead
  return wav(await c.startRendering(), pre);
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
