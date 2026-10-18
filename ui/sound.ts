// Sonification: the agents make the sound. A voice is a tone at its note's key (MIDI pitch) that sustains while the agent runs
// and plucks off when it ends; errors blip, Master frames chime, the metronome clicks the beat. Plain Web Audio, no dependencies.
const load = (k: string, d: any) => { try { const v = localStorage.getItem(`agentloops.sound.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k: string, v: any) => { try { localStorage.setItem(`agentloops.sound.${k}`, JSON.stringify(v)); } catch {} };
export const sound = { on: load("on", true) as boolean, vol: load("vol", 0.6) as number, metro: load("metro", false) as boolean };
const stats = { started: 0, stopped: 0, active: 0, chimes: 0, blips: 0, clicks: 0, events: 0 };
(window as any).__sound = stats;
const MAX = 24; // ponytail: at most 24 sustained tones; later voices are silent until one ends. Steal the oldest if big chords matter

let ac: AudioContext | null = null, out: GainNode;
/** Browsers only allow audio after a user gesture: call this from Play, Space and the speaker button. */
export function unlock() {
  if (!ac) {
    try { ac = new AudioContext(); } catch { return; }
    const comp = ac.createDynamicsCompressor(); // a limiter so a full band never clips
    comp.threshold.value = -20; comp.knee.value = 6; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.2;
    out = ac.createGain(); out.gain.value = sound.vol;
    out.connect(comp); comp.connect(ac.destination);
  }
  ac.resume().catch(() => {});
}
const live = () => !!ac && sound.on && ac.state === "running";
export function setOn(v: boolean) { sound.on = v; save("on", v); if (v) unlock(); if (!v) stopAll(); }
export function setVol(v: number) { sound.vol = Math.max(0, Math.min(1, Math.round(v * 20) / 20)); save("vol", sound.vol); if (ac) out.gain.setTargetAtTime(sound.vol, ac.currentTime, 0.03); }
export function setMetro(v: boolean) { sound.metro = v; save("metro", v); if (v) unlock(); }

const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);
const TIMBRE: Record<string, { type: OscillatorType; peak: number; hold: number; lp?: number }> = {
  script: { type: "triangle", peak: 0.16, hold: 0.07 }, "llm.agent": { type: "sawtooth", peak: 0.12, hold: 0.05, lp: 1400 }, harness: { type: "square", peak: 0.06, hold: 0.025, lp: 2400 },
};
const tones = new Map<string, { osc: OscillatorNode; g: GainNode }>();
/** A voice started: a tone that holds until voiceEnd. A slow agent is an audible drone. */
export function voiceStart(id: string, key: number, plugin: string) {
  stats.events++;
  if (!live() || tones.has(id) || tones.size >= MAX) return;
  const t = ac!.currentTime, tb = TIMBRE[plugin] ?? TIMBRE.script, osc = ac!.createOscillator(), g = ac!.createGain();
  osc.type = tb.type; osc.frequency.value = hz(key ?? 60);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(tb.peak, t + 0.02); g.gain.exponentialRampToValueAtTime(tb.hold, t + 0.35);
  let node: AudioNode = osc;
  if (tb.lp) { const f = ac!.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = tb.lp; osc.connect(f); node = f; }
  node.connect(g); g.connect(out); osc.start(t);
  tones.set(id, { osc, g }); stats.started++; stats.active = tones.size;
}
/** The voice ended: a soft pluck and release. failed: plus a dissonant blip. */
export function voiceEnd(id: string, failed = false) {
  stats.events++;
  const v = tones.get(id);
  if (v && ac) {
    const t = ac.currentTime, g = v.g.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(Math.max(0.0001, g.value), t); g.linearRampToValueAtTime(0.14, t + 0.012); g.exponentialRampToValueAtTime(0.0001, t + 0.45);
    v.osc.stop(t + 0.5);
    tones.delete(id); stats.stopped++; stats.active = tones.size;
  }
  if (failed) blip();
}
export function stopAll() { for (const id of [...tones.keys()]) voiceEnd(id); }
function ping(freqs: number[], type: OscillatorType, peak: number, dur: number, at = 0) {
  const t = ac!.currentTime + at, g = ac!.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(out);
  for (const f of freqs) { const o = ac!.createOscillator(); o.type = type; o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + dur + 0.05); }
}
/** an error frame, a declined harness voice, a failed voice */
export function blip() { stats.events++; if (!live()) return; ping([233, 247], "square", 0.08, 0.14); stats.blips++; }
/** a frame reached Master: a bright two-note chime */
export function chime() { stats.events++; if (!live()) return; ping([1568], "sine", 0.12, 0.7); ping([2093], "sine", 0.09, 0.9, 0.08); stats.chimes++; }
export function click(accent: boolean) { if (!live() || !sound.metro) return; ping([accent ? 1760 : 1175], "sine", accent ? 0.16 : 0.09, 0.05); stats.clicks++; }
