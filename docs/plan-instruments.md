# Plan: more instruments

Status: planned 2026-10-18. Slice A in progress on branch `slice-8-instruments` (2026-10-19).

**Priorities:** a grand piano for mellow songs, and saxophone plus other jazz instruments. A synth can't make a convincing piano or sax, so these two are **sampled**. That's new infrastructure: today every sound in `ui/sound.ts` is synthesized with plain Web Audio. Everything else in this plan stays synthesized.

## Feedback from a song agent (2026-10-19, after slice A)

An agent writing a jazz/kawaii song ("Strawberry Bebop") listed what it had to fake. Verified against the code where possible.

**Stand-ins it used, most needed first:**
1. **Ride cymbal** (GM 51, bell 53). The manual's jazz tips (docs/manual.md:200) say to play a ride, but there is none: 51 is a rim click, so the song used a closed hat (42). A **brushes** kit (snare swish) would also replace its "Brushes (ghost notes)" channel, which is really a quiet second kit. *This is the top item: the manual tells songs to use a sound that doesn't exist.*
2. **Upright bass, sampled.** The walking bass was a triangle. Needs E2 (40) and below; that song walks down to F3 (41).
3. **Vocal chops** (sampled "ooh/aah/ha" or a formant synth). The scat line was a square. Central to kawaii bass, so it helps every song in that style. *Not in this plan yet.*

**Gaps in the kit and sound list:**
4. **Toms** (41–50): all rim clicks today, so fills only have the snare. (Was slice C.)
5. **Rhodes epiano**: bell was standing in. Needed for lo-fi and neo-soul.
6. **Vibraphone or glockenspiel**: jazz and kawaii, a softer bell hook. (Iowa has "Bells" for glockenspiel.)
7. **Growl/wobble bass** for kawaii future bass drops; only `sub` exists. (Was slice C.)

**Limits of the new samples:**
- **Sax loop points:** a note longer than its 2.5–4 s recording cuts off, which blocks ballad endings and held notes (the `ponytail:` in ui/sound.ts).
- **A low horn:** the alto stops at 49 (C#3), so there's no low horn line. Free tenor sax wasn't found; Iowa has a tenor trombone. *Not in this plan yet.*
- **Per-channel reverb and pan:** only the sax has a reverb setting (`wet: 0.25`), and channels can't set reverb or pan, so the band sounds flat. Notes already carry `pan` (src/project.ts:249) but ui/sound.ts ignores it. *Not in this plan yet; it overlaps "Not in this plan: per-channel knobs".*

**Finding instruments:**
- Every sound gets a manual line with its key range, what vel does and what happens to long notes, like piano and sax have.
- **Stale SKILL.md:** a song folder's `.claude/skills/agentloops/SKILL.md` is written once by `init`/connect and never refreshed (src/connect.ts:61 skips existing files), so it didn't mention piano or sax; the agent found them by searching the installed package. Have `init` (or the MCP server on startup) refresh it, so new sounds show up on their own. *Not in this plan yet.*

**Effect on the slices:** slice B starts with the ride (51, bell 53, 59) and brushes, then the upright, and pulls toms and the GM keys forward from C. The new items above (vocal chops, sax loops, a low horn, channel reverb/pan, SKILL.md refresh) need a decision on which slice they join.

## Where things are today

| What | Where |
|---|---|
| Instrument list (UI) | `ui/sound.ts:11` `SOUNDS` |
| Instrument list (validator, a duplicate: "keep in sync") | `src/project.ts:45-46`, checked at `src/project.ts:120` |
| Sustained instruments | `SUSTAIN` table in `ui/sound.ts` |
| One-shot dispatch (hard-coded `pluck`/`bell`/`drums`) | `ui/sound.ts:93` `note()`, `ui/sound.ts:118` in `voiceStart()` |
| Live voice → sound | `ui/main.ts:136` calls `voiceStart(id, key, plugin, {sound, gain, dur}, at)` |
| Voice start event (no `vel` yet) | `src/engine.ts:135` |
| Export score (no `vel` yet) | `src/studio.ts:131`; type `Score` at `ui/sound.ts:180`, `renderWav` at `ui/sound.ts:182` |
| Static UI serving (only `ui/*.ts\|css`) | `src/studio.ts:237` |
| Sound dropdown | `ui/make.ts:189` |
| Docs agents read (also becomes SKILL.md / AGENTS.md via `MANUAL`) | `docs/manual.md:165-190` "Making music" |
| Existing headless export test to copy from | `test/export.test.ts` "audio_export with no tab renders in headless Chromium" |

Notes already carry `vel` (0–1, default 0.5, `src/project.ts:249`). It means agent "effort", but script instrument channels ignore effort, so sampled sounds can use it for dynamics without conflict. The engine has no swing setting.

## Sample sources

| Sound | Source | License |
|---|---|---|
| `sax` (Eb alto) | [University of Iowa Musical Instrument Samples](https://theremin.music.uiowa.edu/MIS.html) | Free "for any projects, without restrictions"; they ask for a citation or link |
| `piano` | Salamander Grand Piano (recommended), or Iowa's piano | Salamander is CC BY 3.0 (Alexander Holm). [One source](https://github.com/educandu/abcjs-soundfonts) says it's public domain since 2022, unconfirmed, so keep the attribution. Iowa: no restrictions, drier (recorded in an anechoic room) |
| Slice B: upright bass (plucked), vibraphone, maybe muted trumpet | Iowa | As above. Check which playing styles exist before relying on them |

Iowa recorded each note at pp, mf and ff. Mellow songs want the pp and mf recordings. Iowa has only alto and soprano sax; I didn't find a free tenor with a clear license ([Weresax](https://www.kvraudio.com/product/weresax-by-karoryfer/details) is also alto, license unchecked).

Attribution goes in `ui/samples/NOTICE`, with a line in the README.

## Sampler design

1. **Prep script, run once:** `scripts/samples.mjs` downloads the source recordings, then uses ffmpeg to split, trim leading silence, normalize and encode mono MP3s, one note every minor third (3 semitones), into `ui/samples/<sound>/<midi>[-p|-f].mp3`. Commit the output; `ui/` is already in package.json `files`, so it ships. The script is only there so the samples can be rebuilt. Budget: about 2 MB per instrument per layer.
2. **Serve:** a new route in `src/studio.ts` for `GET /ui/samples/<sound>/<file>.mp3` (`audio/mpeg`, long cache), with a `[\w-]+` path check.
3. **Play:** a `SAMPLED` table in `ui/sound.ts`: `{ piano: { roots: [...], rel: 0.3 }, sax: { roots: [...], rel: 0.12, wet: 0.25 } }`. A note picks the nearest root (at most 1.5 semitones away) and sets `playbackRate = 2 ** ((key - root) / 12)`. It goes through a `hit`-style envelope and is released at the note's end, like the sustained instruments. A sax note longer than its recording fades at the recording's end. `ponytail:` no loop points; add crossfade loops if long held sax notes matter.
4. **Load:** buffers are cached per audio context (`fetch` + `decodeAudioData`). Live: preload the sampled sounds a song uses when it opens and when a channel's Sound changes. A note that arrives before its buffer is ready is skipped. Export: `renderWav` awaits every sampled sound in the score before `startRendering()`, so headless export keeps working.
5. **Dynamics:** pass `vel` through `src/engine.ts:135` (voice start), `ui/main.ts:136` (into `VoiceSound`) and `src/studio.ts:131` (score notes plus the `Score` type). For sampled sounds, vel < 0.4 uses the soft layer, otherwise mf, and gain scales with vel. Synth sounds ignore vel for now.
6. **Dispatch:** replace the `pluck`/`bell`/`drums` checks with tables. `ONESHOT` holds pluck, bell and drums; `SAMPLED` sounds go through the sampler. A sound is sustained when it's in neither.
7. **Grouping:** a `FAMILIES` record in `ui/sound.ts` (keys, bass, lead, pad, mallets, drums, fx); `SOUNDS = Object.values(FAMILIES).flat()`. The make.ts dropdown uses `<optgroup>` per family. Also add the new names to the validator list in `src/project.ts`.

## Slices

### A: sampler, piano, sax

- [x] Questions below answered
- [x] `scripts/samples.mjs` and committed `ui/samples/piano`, `ui/samples/sax`, `ui/samples/NOTICE`
- [x] Studio route for samples
- [x] `SAMPLED`, `ONESHOT` and `FAMILIES` in `ui/sound.ts`; preloading; `renderWav` awaits buffers
- [x] `vel` plumbed through (engine event, main.ts, export score)
- [x] Validator list and grouped dropdown
- [x] Test (see [Check](#check))
- [x] `docs/manual.md`: the new sounds, vel for dynamics, and jazz tips:
  - Swing: write 8th notes at ticks 0 and 64 of each beat (96 ticks per beat)
  - ii–V–I with rootless 9th/13th voicings (in C: Dm9 → G13 → Cmaj9)
  - Walking bass on quarter notes
  - Ride "ding ding-a ding"; hi-hat (44) on 2 and 4
  - Comping on the "and" of 2 and 4
  - Mellow piano: vel 0.3–0.45, 60–80 BPM
- [x] You listen in the studio

### B: the rest of the jazz band

- [ ] Sampled (Iowa): `upright` (plucked double bass), `vibes` (vibraphone), and `trumpet` if Iowa has a usable muted one
- [ ] Synth `brushes` kit: GM keys like `drums`, but brush slap on 38, a sustained brush swirl on 40 and a soft kick
- [ ] Ride for `drums` and `brushes` on 51/59: metallic squares at 808 cymbal ratios through a highpass
- [ ] Synth `epiano`: FM Rhodes, a bright bite on the attack that fades, plus tremolo
- [ ] Synth `organ`: Hammond drawbars, sines at 1×, 2×, 3×, 4×, with a key click and a slow stereo wobble like a rotating speaker

### C: the earlier synth list

All pure Web Audio in `ui/sound.ts`:

| Family | Sound | How it's made |
|---|---|---|
| Pads | `pad` | 3 detuned saws, slow attack, slow filter sweep, long release, lots of reverb |
| | `strings` | Saw ensemble, soft attack, vibrato that comes in late |
| | `choir` | A saw through three vowel filters for "ah" (800 / 1150 / 2900 Hz), vibrato |
| Bass | `reese` | Two saws detuned ±12 cents, drifting lowpass (DnB), pumped by the kick |
| | `acid` | 303-style: a resonant lowpass (Q 12) that drops from 2.5 kHz to 300 Hz on each note |
| | `wobble` | A lowpass swept by an LFO in 8th notes at the song's tempo (dubstep), pumped |
| | `808` | A sine tuned to the key, dropping from +12 semitones in 30 ms, soft WaveShaper saturation; rings for the note's length |
| Leads | `brass` | A saw whose lowpass opens from 400 Hz to 3 kHz over 80 ms |
| | `flute` | A sine with some bandpassed breath noise and delayed vibrato |
| One-shots | `marimba` | A sine plus 4× and 10× partials that fade quickly |
| | `guitar` | Karplus-Strong string: a buffer computed in JS, cached per key and audio context |
| FX | `noise` | Filtered noise centred on the key, for risers and sweeps |

New GM keys for `drums` (today they fall through to the rim click): 37 side stick, 41/43/45/47/48/50 toms, 54 tambourine, 56 cowbell (808: 540 + 800 Hz squares, bandpassed), 70 maracas, 75 claves.

Engine changes C needs:
- **Slow-attack fix:** the hold point at `t + 0.35` (`ui/sound.ts:80`) comes before the peak when `a` > 0.35. Change it to `t + Math.max(0.35, s.a + 0.1)`.
- **Tempo for `wobble`:** add `bpm` to `VoiceSound` (main.ts has `bpm()`) and pass it into `make`; `renderWav` passes `s.bpm`.

### D (optional): a demo song

A mellow piano piece or a jazz trio (piano, upright, brushes, sax), in `examples/` next to `kawaii-bass.alp.json`, so it shows up in the studio Browser.

## Check

One headless-Chromium test in `test/export.test.ts`, built on the existing export test. Make a project with one channel per sound in `SOUNDS` (from the validator list, so a sound missing from the UI shows up), each playing one note in its own bar (a kick for drums). Export a WAV, cut it into bars, and assert that every bar:
- is not silent
- has no NaN samples
- has an RMS within about ±6 dB of `triangle`, which catches gain-staging mistakes

The test is skipped when Chromium isn't installed, like the existing one. Whether a sound is any good still needs a human listening in the studio.

## Decided before slice A (2026-10-19)

Answers: Salamander piano (v5 soft, v10 mf layers), Iowa alto sax with vibrato, samples ship in the npm package.

As built: piano roots stop at 105 (Salamander's C8 sample measures ~+125 cents sharp; 106–108 play root 105 pitched up). Sax notes are retuned to equal temperament (the Iowa player runs up to +50 cents sharp from G4 up), and the script checks that each sax sample holds its note. The export test allows ±10 dB, not ±6, because `sub` (+6.9) and `pluck` (-8.6) already sit outside ±6.


1. **Piano:** Salamander (warmer, needs attribution; recommended) or Iowa (drier, no restrictions)?
2. **Sax:** is alto OK? I found no free tenor with a clear license.
3. **Package size:** about 10 MB of MP3s in the npm package once A and B are done. OK, or should samples download on first use instead? That's more code and needs a network connection.

## Not in this plan

- **Per-channel synth knobs** (attack, release, cutoff), like FL's channel settings.
- **A swing setting** in the engine: written swing (ticks 0 / 64) covers it for now.
- **Loading SoundFonts or SFZ files**, or using your own samples.
