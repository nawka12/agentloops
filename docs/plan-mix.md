# Plan: mixing (slice I)

Status: built 2026-10-28, not merged. The user listened and approved the mix 2026-10-28.

**Source:** the "Mixing" section of `~/agl-song/perisai-jitu/agentloops-feedback.md`. The song agent rated the recreation's mix the biggest gap after the instruments. Items 1-4 are built here. Item 5, automation over time, stays under "Not supported yet" in the manual.

## The requests

1. **Stem export:** `audio_export` with `stems: true` writes one WAV per channel, all the same length. The workaround was one soloed export per channel.
2. **A real master limiter** in place of the compressor (threshold -20, knee 6, ratio 12, which the code called a limiter). Gachikoi's drops came out under its choruses, and Tetosphere's drops under its builds.
3. **Per-channel mix settings:** pan, EQ, a compressor, a reverb send that overrides the sound's fixed `wet`, and a send to a new tempo-synced delay.
4. **A configurable sidechain:** which channels the kick ducks, and how deep.

## Decisions (the user, 2026-10-28)

- **Every song gets the limiter by default.** A song setting brings the old compressor back. Existing songs sound different, and that's accepted.
- **Every other default keeps today's sound.** A song with no new settings renders as before except for the master stage.

## Decisions made while building

- **Where the song's audio settings live: a top-level `mix`**, next to the channels' `mix`. `mixer.master` is the agents' Master bus: its `slots` (`fx.gate`, `fx.limiter` on cost) and `sends` route frames, and the bus validator checks it. Putting sound there would give one object two meanings, and an "fx.limiter" next to an audio limiter would invite mistakes. `clock` is about time. A top-level `mix` uses the same word at both levels: a channel's `mix` is how that part sounds, and the song's `mix` is the master stage and the shared delay.
- **Master stage (`mix.master`):** `"limiter"` (default), `"compressor"` (the old one, exactly) or `"none"`. `"none"` exists for mastering elsewhere, and for the test that sums the stems against the mix.
- **The limiter** is a DynamicsCompressor at threshold -1 dB, knee 0, ratio 20, attack 0 (Chromium's minimum) and release 0.1 s, between a drive gain (`DRIVE` 1.8, +5.1 dB) and a trim (`TRIM` 0.72, -2.85 dB). Web Audio's compressor always adds makeup gain, `(1 / gain at 0 dBFS)^0.6`, which is +0.6 dB here. The drive sets the loudness, measured to land near the old loudness (below). The trim keeps the true peak under -1 dBTP. That needs about 1 dB of margin for the compressor's attack overshoot, and another 0.5-1 dB for inter-sample peaks: the compressor works on samples and isn't oversampled.
- **Stems: one render per stem, one after the other in the same page.** I didn't use one OfflineAudioContext with a ChannelMerger, for three reasons:
  - Memory: such a context holds every stem of the whole song at once as float32. For 12 stems of a 3-minute song that's about 760 MB, on a 7.6 GB laptop.
  - Chromium caps a context at 32 channels, which is 16 stereo stems.
  - Sequential renders hold one stereo buffer at a time. Each stem is uploaded as soon as it's done (`POST /api/export/:id/stem?ch=<id>`), and the host writes it to disk as it lands.

  A stem render only plays its own channel's notes, so with the speed trick it costs less than the mix. Gachikoi (12 channels, 2:14) renders its mix in 14 s and all 11 stems in 28 s; the muted guide gets none. The kicks of the other channels still play silently: they only move the duck stages, so a pumped stem pumps.
- **Stems are wet and pre-master:** each stem has its own reverb and delay, and no master stage. They include the export's `out` level (0.8) but not the limiter's drive, so they sum to the mix with `mix.master: "none"`, which is 5.1 dB under the limited mix.
- **Stem names:** `<song>-stems/<nn>-<channel id>.wav`, where `nn` is the channel's place in the channel list (01, 02...). A DAW imports them in rack order, and two ids that clean up to the same file name can't collide. `file` names the folder, with the same plain-name rule as before. `overwrite: true` deletes the folder's old `<nn>-*.wav` files once the first stem arrives (so a removed channel doesn't leave a stale stem) and leaves other files alone.
- **Seeded noise:** the reverb's impulse response and the shared noise buffer now come from a seeded PRNG (mulberry32) instead of `Math.random`, the same in every render. That's what makes the stems sum to the mix: the residual measured -69.5 dB. Sounds that draw a random number per note (the Karplus-Strong burst, the takes' 0-8 ms delay) still differ between renders.
- **A channel's pan adds to the note's pan, at the note.** The channel chain has no panner. Each note already plays into its own panner, so the channel's `pan` is added to the note's (clamped to -1…1). A second panner in series wouldn't add up: a stereo panner on an already panned signal does something else. Doing it at the note also means a channel panned with `mix.pan` gets its side's double-track take (`distguitar`, the recorded guitars) without a pan on every note.
- **The chain:** one per context and channel, keyed by the channel, its sound and its `mix` JSON. Notes go in, then a highpass, a lowpass, peaking bands, the compressor, the duck, and `out`. It's built like `amp()`: kept for the whole render, and an export note's own bus is rewired into it (`into()`). So a note's sources are still cut loose when they end, and the chain stays. renderWav builds every chain up front, so the first kick already ducks it. Live, the chain is built at the channel's first note.
- **Sends:** they're taken after the compressor and before the duck. `reverb` replaces the sound's own sends (for a kit, every piece's) with one send of that level, downmixed to mono so it stays centred like the sounds' sends. Without `reverb`, the sound's own sends stay as they are: before the EQ, centred. `delay` goes to the new shared delay. That's a DelayNode in a feedback loop, with `time` in 16th steps retuned when the tempo changes, `feedback` 0-0.95 and at most 6 s. Its return goes to `out`, so the kick doesn't duck it; the reverb return still sits on the pump as before. `ponytail:` plain digital repeats, with no filter in the loop.
- **Compressor lookahead:** a compressed channel would come out 6 ms late (the compressor's fixed lookahead). Its notes start 6 ms early instead (`late()`), live and offline. So that a note at tick 0 can start early, renderWav now schedules every note 6 ms in and cuts that off the file, along with the master's own 6 ms when there's a master stage.
- **Sidechain:** each chain has its own duck stage. `duck` is its depth, defaulting to 0.72 (today's dip to 0.28) for the pumped sounds and the one-shots on the pump (`pluck`, `bell`, `marimba`), and to 0 otherwise. `duckBy` names the kit channel whose 35/36 triggers it, a `rock` kit included. Without it, any kit's kick except `rock`'s triggers it, as today. A channel without `mix` stays on the shared pump, unchanged. One function, `duckAt()`, does the dip for the shared pump and for every chain.
- **A channel without `mix` gets no chain at all:** the same routing as before. A pan of 0 is constant-power -3 dB on a mono source, so an always-on chain with a panner would have changed every song.

## The format

```json
{
  "mix": { "master": "limiter", "delay": { "time": 3, "feedback": 0.35 } },
  "channels": [
    { "id": "drums", "sound": "drums" },
    { "id": "lead", "sound": "supersaw",
      "mix": { "pan": -0.3, "eq": { "highpass": 120, "lowpass": 9000, "bands": [{ "f": 350, "q": 1, "db": -3 }] },
               "comp": { "threshold": -18, "ratio": 3, "knee": 6, "attack": 0.01, "release": 0.15 },
               "reverb": 0.1, "delay": 0.15, "duck": 0.5, "duckBy": "drums" } }
  ]
}
```

The validator (`src/project.ts`) checks:
- unknown keys at every level, so a typo is an error and not a silent no-op
- `pan` -1…1; `reverb`, `delay` and `duck` 0…1
- `highpass` and `lowpass` 20-20000 Hz, with `lowpass` above `highpass`
- at most 8 bands: `f` 20-20000, `q` 0.1-30, `db` -24…24, with `f` and `db` required
- `comp`: threshold -60…0, ratio 1-20, knee 0-40, attack 0-1, release 0-1
- `duckBy` must name an existing kit channel
- `mix.master` must be one of the three; delay `time` 0.25-16 and `feedback` 0-0.95

Every error has a path, a message and a fix, like the existing checks.

## As built

| What | Where |
|---|---|
| Master stage, delay, seeded noise | `ui/sound.ts` `master()`, `rig()`, `setMix()`, `tempo()` |
| Channel chain, sidechain, rewiring | `ui/sound.ts` `chainOf()`, `duckAt()`, `into()`; `note()` takes the channel's `mix` |
| Stems render | `ui/sound.ts` `renderWav(score, rate, stem)` |
| Live | `ui/main.ts` passes `mix` to `voiceStart` and the song's `mix` to `songMix()` on every state |
| Stems in the page | `ui/main.ts` `hostExport` (`stems`) |
| Upload route, score fields | `src/studio.ts` `POST /api/export/:id/stem`, `/api/score` (`mix`) |
| Broker | `src/export.ts` (`stem` callback, `ok(null)` when done) |
| Tool | `src/host.ts` `audio_export` (`stems`) |
| Validator | `src/project.ts` `mixChannel()` and the song's `mix` |
| Tests | `test/mix.test.ts` |

- **`test/export.test.ts` changed:** "every sound renders" now renders through `mix.master: "compressor"`. Its ±10 dB band was calibrated through the old compressor, which evens out sounds played one at a time. Through the limiter, `sub` sits 15 dB over `triangle` (+9 before) and `trombone` 11 dB over (+10.9). That's the raw level the compressor used to hide. It doesn't change any song's balance: a master stage turns every part down by the same amount at any moment, so it only changes how sections and transients compare.
- **Live:** a smoke test (headless Chromium over CDP, `--autoplay-policy=no-user-gesture-required`) played kicks plus `sub`, `pad` and `distguitar` with channel mixes through `voiceStart`, then switched `songMix` between all three masters. It threw no errors and every voice started and stopped. That proves the live code runs. It says nothing about how it sounds.

## Measurements

Integrated loudness and true peak by `ffmpeg -af ebur128=peak=true`, rendered by headless export from copies of the songs (the originals were not written).

| Song | Before: old compressor | After: limiter | Pre-master (`none`) |
|---|---|---|---|
| `examples/kawaii-bass` | -12.0 LUFS, -3.9 dBTP | -11.9 LUFS, -2.1 dBTP | |
| tasukaru | -15.7 LUFS, -3.9 dBTP | -16.6 LUFS, -1.8 dBTP | |
| gachikoi-supacha-raburetaa | -12.6 LUFS, -3.6 dBTP | -12.6 LUFS, -1.8 dBTP | -14.8 LUFS, +0.2 dBTP |
| tetosphere | -13.2 LUFS, -3.7 dBTP | -12.8 LUFS, -1.4 dBTP | -14.6 LUFS, +0.3 dBTP |

The first try, at +6 dB drive and -2.2 dB trim, gave -10.4, -15.2, -11.2 and -11.5 LUFS, with Tetosphere at -0.5 dBTP: too hot, and over the peak target. Tasukaru is a quiet mix (piano, glock); the old compressor's +11 dB of makeup gain lifted it more than the limiter does. A fixed master gain can't match every song; if it should be louder, raise its `gain`s.

**Sections (the bug that motivated the limiter):**

| Song: sections | Before | After | Pre-master |
|---|---|---|---|
| Tetosphere: build1 / drop1 | -12.9 / -13.1 | -12.5 / -12.7 | -14.0 / -14.5 |
| Tetosphere: build2 / drop2 | -12.9 / -13.1 | -12.5 / **-12.2** | -14.0 / -13.8 |
| Tetosphere: build3 / drop3 | -13.0 / -13.2 | -12.6 / **-12.3** | -14.1 / -13.9 |
| Gachikoi: chorus1 / drop1 | -12.1 / -13.0 | -11.4 / -13.7 | -13.5 / -15.7 |

- Before, every Tetosphere drop came out under its build, though drops 2 and 3 are louder than their builds before the master. The compressor reordered them; now they're in their pre-master order.
- Gachikoi's drop1 is 2.2 dB under chorus1 already before the master: the drop has no `sub`. Setting `mix.duck: 0.35` on its pumped `stab` and `growl` moved it by 0.1 dB, so it's the arrangement, not the pump. The fix is in the song: raise the drop's gains, or add the bass.
- The test in `test/mix.test.ts` reproduces this. A pad plus a supersaw chord, then the same with a kick on every 8th: the old compressor gets the two within +0.3 dB of each other, and the limiter makes the denser one 3.1 dB louder. Its hot render peaks at -2.1 dBFS.

## Check

`test/mix.test.ts`:
- Validator errors for bad `mix` values.
- Stems: one per sounding channel (not the muted or the empty one), all the mix's length, summing to a `none`-master mix within -69.5 dB.
- Sidechain: a pumped `sub` stem dips 11 dB on a kick that isn't in its stem; the `rock` kick ducks nothing by default; `duck: 0` stays flat; `duck: 0.9` dips 18 dB; `duckBy: "rock"` dips only on the rock kick.
- The limiter: peak and density, as above.
- One render where each channel's mix is heard alone:
  - a 1500 Hz highpass takes 110 Hz down 45 dB
  - `pan: -1` is left only
  - a compressor flattens the attack bump from 5.6 to -0.7 dB
  - `reverb: 1` leaves a tail where there was silence
  - a 4-step delay repeats a beat later

Whether the mix sounds good still needs a person listening in the studio.

- [x] Stems: `audio_export` `stems: true`, one browser, WAV, refusing to overwrite
- [x] Master limiter by default; the song's `mix.master` brings back `"compressor"` or bypasses it with `"none"`
- [x] Channel `mix`: pan, EQ, compressor, reverb, delay; the song's `mix.delay`
- [x] Sidechain: `duck`, `duckBy`
- [x] Validator, manual (project fields, the tool, the craft text), tests
- [x] Loudness measured before and after
- [x] You listen in the studio (the mix approved 2026-10-28)

## Not in this slice

- **Automation over time** (request 5): channel volume, filter and send levels over time. It stays under "Not supported yet".
- **Mix controls in the studio UI:** the Mixer panel shows the agents' buses. A channel's `mix` is edited as JSON, by an agent or `project_patch`. The ⤓ button exports the mix only; stems are an MCP call.
- **MP3 stems, per-bus stems, and a stem of the reverb alone.**
- **A darker delay** (a filter in the feedback loop), **ping-pong**, and **reverb settings per song**.
