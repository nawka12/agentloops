# Plan: more instruments

Status: planned 2026-10-18. Slices A and B merged 2026-10-19. J-rock and ballad slices (C, D) planned 2026-10-20; the earlier synth list moved to E. Slice C merged 2026-10-20. Slice D built on `slice-11-ballad` and approved 2026-10-20. Question 4 under [Decide before slice C](#decide-before-slice-c-2026-10-20) is still open for D.

**Priorities:** a grand piano for mellow songs, and saxophone plus other jazz instruments. A synth can't make a convincing piano or sax, so these two are **sampled**. That's new infrastructure: today every sound in `ui/sound.ts` is synthesized with plain Web Audio. Everything else in this plan stays synthesized.

**Next priorities (2026-10-20):** J-rock and ballad songs. J-rock needs guitars, an electric bass and a rock kit (slice C). Ballads need strings, an acoustic guitar and orchestral colour (slice D).

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
- **Sax loop points:** a note longer than its 2.5–4 s recording cuts off, which blocks ballad endings and held notes (the `ponytail:` in ui/sound.ts). *Fixed in slice D.*
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
| Slice D: string sections, harp, glockenspiel, timpani; maybe solo violin, suspended cymbal | [VSCO 2 Community Edition](https://github.com/sgossner/VSCO-2-CE) | CC0. Has violin, viola and cello sections (`susVib`, two layers `v1`/`v2`, plus pizz and tremolo), `Strings/Harp`, `Strings/Solo Violin`, `Percussion/Glock`, `Percussion/Timpani` (hits and `Rolls`), `VSCO 1 Percussion/varMetal/Cymbals/susp`. No drum-kit crash, china or splash |

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

Scope as decided on 2026-10-19 (see [Decided before slice B](#decided-before-slice-b-2026-10-19)):

- [x] Sampled (Iowa), mf plus a pp soft layer, one root every 3 semitones:
  - `upright`: plucked double bass, roots 28–67 (E1–G4)
  - `vibes`: vibraphone, sustain pedal, roots 48–87 (C3–Eb6)
  - `trombone`: tenor trombone, roots 40–70 (E2–Bb4), the low horn
  - `trumpet`: open Bb trumpet with vibrato, roots 52–85 (E3–C#6)
- [x] Ride for `drums` and `brushes`, sampled from Iowa's 21" ride: 51/59 the bow, 53 the bell (vel < 0.4 the pp hit)
- [x] GM keys for both kits, pulled forward from C: 37 side stick, 41/43/45/47/48/50 toms, 54 tambourine, 56 cowbell, 70 maracas, 75 claves
- [x] Synth `brushes` kit: GM keys like `drums`, but brush slap on 38, a brush swirl on 40 that lasts the note's length, and a soft kick
- [x] Synth `epiano`: FM Rhodes, a bright bite on the attack that fades, plus tremolo
- [x] Synth `organ`: Hammond drawbars, with a key click and a slow stereo wobble like a rotating speaker
- [x] A `horns` family (sax, trumpet, trombone) in the dropdown
- [x] SKILL.md refresh: `init`/connect rewrites the agentloops-owned SKILL.md, and the MCP server refreshes an existing one on startup
- [x] Manual: a line per new sound (key range, what vel does, long notes), the ride in the jazz tips
- [x] Export test covers the new sounds
- [x] You listen in the studio (approved 2026-10-19)

As built: the ride is loudness-normalized (mean -40 dB), not peak-normalized: the stick click set the mf hit's peak, so the pp hit came out 10 dB louder. Brass is spikier than the sax, so `trumpet` and `trombone` have higher `peak`s in `SAMPLED`. The Iowa pp vibes C6–F6 file has no C#6, and the vibes sit about 10 cents sharp (left as recorded). Upright and vibes splits need per-file silence levels and a highpass on the whole recording (`fix`, `hp` in `scripts/samples.mjs`). Iowa downloads ran at ~25 KB/s from the laptop; the friend machine fetched the vibes at ~0.5 MB/s.

### C: J-rock band

Planned 2026-10-20, for anime-opening J-rock: 150–200 BPM, distorted guitars, a busy bass, a crash at the top of every section.

| Part | Today | New |
|---|---|---|
| Rhythm and lead guitar | `saw` or `supersaw` stand in | `distguitar` |
| Clean guitar (verse arpeggios) | `pluck` | `eguitar` |
| Electric bass | `sub` (a sine), `upright` (jazz pizz) | `ebass` |
| Rock drums | `drums` sounds electronic: an 808-style kick that ducks the pump bus, a noise snare, and a crash that's just highpassed noise | `rock` kit, sampled crash |
| Double-tracked guitars (the same part twice, panned left and right) | notes carry `pan` (src/project.ts:249), but ui/sound.ts ignores it | note pan |

- [x] Questions answered (see [Decide before slice C](#decide-before-slice-c-2026-10-20))
- [x] A Karplus-Strong string, moved here from E's `guitar`: a buffer computed in JS (about 4 s), cached per key and audio context. `eguitar`, `distguitar` and D's `guitar` all play it
- [x] `distguitar`: the string, then drive, then a WaveShaper (tanh, 4× oversampling), then a cabinet (highpass 90 Hz, lowpass 4.5 kHz). The distortion keeps it ringing for the note's length, and it releases fast. vel < 0.4 gives a palm mute: a damped string, lowpass ~1.2 kHz, short. Keys 36–88 (drop C up to E6). Built with one amp per channel instead (see As built)
- [x] `eguitar`: the same string, clean, with a light chorus (a short delay swept by a slow LFO)
- [x] `ebass`: a picked bass. Saw plus square through a lowpass that closes from ~2 kHz to ~600 Hz over 150 ms, with a little saturation. vel brightens the pick. Keys 23–60 (5-string B0 up to C4). Not pumped
- [x] `rock` kit, GM keys like `drums`: a lower, punchier kick that doesn't duck the pump bus; a snare with body (two tones) and a longer, brighter tail with room reverb; the open hat (46) is choked by the closed hats (42/44)
- [x] Sampled cymbals for every kit, like the ride: 49/57 crash, 52 china, 55 splash, each with an mf and a soft hit. Source: Iowa's percussion pages (where the ride came from) or VSCO's suspended cymbal. Use whichever sounds more like a kit crash
- [x] Note `pan`: pass it through like `vel` (engine voice start, main.ts, export score), and add a StereoPanner after the voice gain when pan isn't 0
- [x] A `guitar` family in the dropdown (`eguitar`, `distguitar`, and later `guitar`); `ebass` goes in bass, `rock` in drums; add them to the validator list
- [x] Manual: a line per new sound, plus J-rock tips:
  - Power chords (root, 5th, octave) on `distguitar`; full triads get muddy under distortion
  - Verse: palm-muted 8ths (vel 0.3). Chorus: open chords that ring for a bar
  - Two `distguitar` channels play the same part, panned -0.8 and 0.8
  - Bass: 8th notes on the root, locked to the kick
  - Drums: 8th-note hats in the verse, open hat or ride in the chorus, a crash on beat 1 of every section with a tom fill into it
  - The "royal road" progression IV–V–iii–vi (in C: Fmaj7 → G7 → Em7 → Am), and vi–IV–V–I
  - Last chorus up a half or whole step
- [x] Export test covers the new sounds
- [x] You listen in the studio (approved 2026-10-20, after the guitar fixes)

As built: the cymbals are Iowa's stick hits on an 18" crash (49, 57), a 16" china (52) and a splash (55), at mf and pp, loudness-matched like the ride (`cymbals` in `scripts/samples.mjs`, 0.24 MB); every kit plays them, and the old noise crash is gone. The string's burst is a triangle pluck at 1/5 of the string plus noise (pure noise left high notes with weak fundamentals), and its 2-point average still shortens the top octave: E6 fades within ~0.4 s. A palm mute is a ~0.15 s chug. The open-hat choke works across channels and kits (one drummer). **After the first listen** (distorted guitars sounded thin): the double-tracked pair was one signal (the string is cached per pitch and both channels play the same ticks), so a panned string now plays its side's own take, 4 cents off and 0–8 ms late (L/R correlation 0.27, tested); each channel gets one shared amp per pan instead of a shaper per note, so chords distort together and the channel gain sits after the distortion; and the cabinet is modelled (thump 110 Hz, scoop 400 Hz, presence 2.5 kHz, 24 dB/oct above 5 kHz) after a tight input (highpass 120 Hz, push at 750 Hz). An export note's bus is rewired into the amp, so it is still cut loose when the note ends. **Release fix, for every sound:** `release()` used `cancelAndHoldAtTime`, which adds no event once the envelope has finished, so the release ramp started back at the envelope's last event and every sustained and sampled note faded across its whole length. Each voice now carries its envelope's last `[time, level]` and holds it until the note ends. Sustained sounds got about 2.5 dB louder on a 1 s note; `pluck` went from 0.13 to 0.16 to stay inside the export test's ±10 dB (its peaks hit the limiter, so it only gained 0.7 dB).

### D: ballad

Planned 2026-10-20, for ballads at 60–80 BPM: piano and strings carry the song, and the drums come in late.

| Part | Today | New |
|---|---|---|
| Piano, Rhodes | `piano`, `epiano` | nothing new |
| String section: held chords, swells, counter-lines | none | sampled `strings`, loop points |
| Acoustic guitar arpeggios and strums | none | `guitar` |
| Warm pad | `supersaw` is too bright | `pad`, moved here from E |
| Harp glissandi, glockenspiel ("music box") hooks, timpani at the climax | `bell` | `harp`, `glock`, `timpani` |
| A reverse-cymbal swell into the chorus | none | `noise`, moved here from E |
| Soft drums: side stick in the verse, a crash in the chorus | 37 side stick, plus C's `rock` kit at low vel | nothing new |

- [x] Questions answered (see [Decide before slice C](#decide-before-slice-c-2026-10-20))
- [x] **Loop points** for the sustained sampled sounds (strings, sax, trumpet, trombone): the prep script picks a loop in the steady part of each recording and bakes a crossfade into the file, so `loopStart`/`loopEnd` loop without a click, and `SAMPLED` gets the loop times. Held notes then ring for their full length. This also removes the sax `ponytail:` and unblocks ballad endings (see the song-agent feedback)
- [x] Slow-attack fix, moved here from E (the hold point becomes `t + Math.max(0.35, s.a + 0.1)`): strings and pads need it
- [x] `strings`: sampled VSCO section sustains with vibrato, as one sound: the cello section low, the viola section in the middle, the violin section on top. Two layers (`v1` soft, `v2` mf). vel also sets the attack: soft notes swell in over ~0.4 s. Roots every 3 semitones from the cellos' lowest note up; check the files for the range. wet ~0.35
- [x] `guitar`: steel-string acoustic. C's string, clean and bright, with a body resonance (peaking filters at ~100 and ~200 Hz)
- [x] Sampled from VSCO: `harp` (plucked, decays on its own), `glock`, `timpani` (hits; maybe the roll for notes longer than a beat)
- [x] `pad`: 3 detuned saws, slow attack, slow filter sweep, long release, lots of reverb. `noise`: filtered noise centred on the key, for risers and sweeps
- [x] Solo `violin` (VSCO `Arco Vib`) for counter-melodies, looped like the strings (cello and choir were left out)
- [x] A `strings` family (`strings`, `harp`, `violin`); `glock` and `timpani` go in mallets, `pad` in pad, `noise` in a new fx family
- [x] Manual: a line per new sound, plus ballad tips:
  - 60–80 BPM. Verse 1 is piano alone: roots in the left hand, broken chords in the right
  - Strings come in at the chorus with whole-note chords (vel 0.3–0.4, so they swell), and a counter-line fills the gaps in the melody
  - Drums come in at verse 2 with side stick (37) on 2 and 4; the full kit and a crash arrive in the chorus
  - Strum: put a chord's notes 1–2 ticks apart, lowest string first
  - The royal road progression, and the Canon progression I–V–vi–iii–IV–I–IV–V
  - A `noise` swell or a timpani roll into the last chorus, which goes up a whole step; end on a held chord
- [x] Export test covers the new sounds
- [x] You listen in the studio (approved 2026-10-20)

As built: VSCO names the string sections, the glock, and only those, an octave low (measured; the script maps them and now checks octaves, not just pitch class). `strings` blends the cello section up to 60, violas 62–69 and violins from 72 (VSCO's roots, 2–4 semitones apart), with soft v1 and mf v2 (v3 for the cellos); soft notes swell in (`swell` in `SAMPLED`). `violin` is the solo arco with vibrato, p and f. `harp` and `glock` have one dynamic (`soft: false`); the harp's noisy G1 is left out. `timpani` uses the five drums' measured tunings (41, 47, 49, 52, 55) as roots, rr1 hits only, no rolls. **Loops:** one window per sound (`loop` in `SAMPLED`, copied from `scripts/samples.mjs`); each file is cut at the window's end with a 0.25 s crossfade baked in and a gain ramp that levels the window, and the script fails files whose window isn't steady. Chromium's `decodeAudioData` trims LAME's encoder delay (measured), so no offset is needed. An 8 s note holds within ~1.3 dB on every looped sound (tested). The horns got smaller (they now end at the loop). New samples total 5 MB; `ui/samples` is 14 MB.

### E: the rest of the synth list

All pure Web Audio in `ui/sound.ts`. `guitar` moved to C, and `pad`, `noise` and the slow-attack fix moved to D. Sampled `strings` in D replace the synth strings planned here.

| Family | Sound | How it's made |
|---|---|---|
| Pads | `choir` | A saw through three vowel filters for "ah" (800 / 1150 / 2900 Hz), vibrato |
| Bass | `reese` | Two saws detuned ±12 cents, drifting lowpass (DnB), pumped by the kick |
| | `acid` | 303-style: a resonant lowpass (Q 12) that drops from 2.5 kHz to 300 Hz on each note |
| | `wobble` | A lowpass swept by an LFO in 8th notes at the song's tempo (dubstep), pumped |
| | `808` | A sine tuned to the key, dropping from +12 semitones in 30 ms, soft WaveShaper saturation; rings for the note's length |
| Leads | `brass` | A saw whose lowpass opens from 400 Hz to 3 kHz over 80 ms |
| | `flute` | A sine with some bandpassed breath noise and delayed vibrato |
| One-shots | `marimba` | A sine plus 4× and 10× partials that fade quickly |

D's `noise` is the FX entry: filtered noise centred on the key, for risers and sweeps. The GM drum keys planned here were built in B.

Engine change E needs:
- **Tempo for `wobble`:** add `bpm` to `VoiceSound` (main.ts has `bpm()`) and pass it into `make`; `renderWav` passes `s.bpm`.

### F (optional): demo songs

A mellow piano piece or a jazz trio (piano, upright, brushes, sax), a J-rock song and a ballad, in `examples/` next to `kawaii-bass.alp.json`, so they show up in the studio Browser.

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

## Decided before slice B (2026-10-19)

- **Ride:** sampled (Iowa 21" ride, stick on the bow and the bell) instead of the planned synth ride.
- **Horns:** Iowa has no muted trumpet. Both the open trumpet and the tenor trombone join B.
- **Song-agent items:** the SKILL.md refresh joins B. Vocal chops, sax loop points and channel pan/reverb wait for a later slice.
- Iowa has no brushes or toms, so those stay synthesized.

## Decide before slice C (2026-10-20)

Answered 2026-10-20 (4 just before slice D started).

1. **Guitars:** synth (a Karplus-Strong string through an amp model) first, looking for samples only if it sounds fake? Recommended: distortion hides most synth artifacts, and I haven't found a free electric guitar with a clear license.
   **Answer:** Synth first.
2. **Rock drums:** a synth kick and snare plus sampled cymbals (recommended), or a fully sampled kit (more MB, and a license hunt)?
   **Answer:** Synth kick and snare plus sampled cymbals.
3. **Pan:** use the `pan` notes already carry (recommended: no format change, but an agent sets it on every note), or add a channel `pan`?
   **Answer:** Note `pan`.
4. **Ballad extras:** which of solo violin, cello, choir, harp, glockenspiel and timpani go in D?
   **Answer:** Harp, glockenspiel, solo violin and timpani. No cello and no choir.
5. **Package size:** the samples are 8.9 MB today. Strings, harp, glockenspiel, timpani and cymbals add about 7 MB. OK?
   **Answer:** Yes, about 16 MB is fine.

## Not in this plan

- **Per-channel synth knobs** (attack, release, cutoff), like FL's channel settings.
- **A swing setting** in the engine: written swing (ticks 0 / 64) covers it for now.
- **Loading SoundFonts or SFZ files**, or using your own samples.
- **Pitch bends and slides** (guitar bends, string portamento): the format has no bend, and a note's `slide` means something else (it continues the previous voice's conversation).
