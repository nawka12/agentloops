import { test } from "node:test";
import assert from "node:assert/strict";
import { measure } from "../src/loudness.ts";

/** 16-bit stereo WAV with the 44-byte header renderWav writes; `amp(t)` is each channel's sample at time t (full scale 1) */
function wav(seconds: number, amp: (t: number, i: number) => number, rate = 44100) {
  const n = Math.round(seconds * rate), data = n * 4, b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(data, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, amp(i / rate, c))) * 32767), 44 + 4 * i + 2 * c);
  return b;
}
const sine = (db: number) => (t: number) => 10 ** (db / 20) * Math.sin(2 * Math.PI * 1000 * t);

test("EBU Tech 3341: a 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS and -23.0 dB peak, at 44.1 and 48 kHz", () => {
  for (const rate of [44100, 48000]) {
    const r = measure(wav(20, sine(-23), rate), []);
    assert.ok(Math.abs(r.lufs! + 23) <= 0.1, `${rate}: ${r.lufs}`);
    assert.ok(Math.abs(r.peakDb! + 23) <= 0.1, `${rate}: ${r.peakDb}`);
  }
});

test("spans: a loud part then a part 10 LU quieter", () => {
  const r = measure(wav(20, (t) => t < 10 ? sine(-23)(t) : sine(-33)(t)), [[0, 10], [10, 20]]);
  assert.ok(Math.abs(r.spans[0].lufs! + 23) <= 0.2, JSON.stringify(r.spans));
  assert.ok(Math.abs(r.spans[1].lufs! + 33) <= 0.2, JSON.stringify(r.spans));
});

test("an all-zero span is silent: lufs and peakDb null; a span under 400 ms has no lufs", () => {
  const r = measure(wav(2, () => 0), [[0, 1]]);
  assert.deepEqual(r.spans[0], { lufs: null, peakDb: null });
  assert.deepEqual(r.lufs, null);
  const s = measure(wav(2, sine(-20)), [[0, 0.3]]);
  assert.deepEqual(s.spans[0].lufs, null);
  assert.ok(s.spans[0].peakDb! > -21);
});
