# AgentLoops: a DAW for AI agents

**Status:** Draft v0.1 · **Date:** 2026-10-18 · **Working name:** AgentLoops (project files `*.alp.json`)

> FL Studio arranges *instruments* in *time* and routes their *sound* through a *mixer*.
> AgentLoops arranges *agents* in *time* and routes their *output* through a *mixer*.

---

## 1. Summary

AgentLoops is a desktop/local-web studio for composing, running, debugging and shipping multi-agent workflows. It borrows FL Studio's workflow almost one-to-one:

| You want to say… | In FL Studio you use… | In AgentLoops you use… |
|---|---|---|
| **who** does the work | Channels (generators) in the Channel Rack | **Agent channels** in the Agent Rack |
| **when** they work | Step Sequencer, Piano Roll, Patterns, Playlist | Same names, same mental model |
| **where** their output goes | Mixer inserts, effects, sends, sidechain | **Buses** with **processors**, sends, sidechain |
| **how settings change** | Automation clips, controllers | Automation clips, formula & meter controllers |
| **what happened** | Recording, Edison, audio clips | **Takes**, the Tracer, data clips |
| **ship it** | Render / export | **Render** (headless run), **Serve** (as an API), **MCP** (as a tool for other agents) |

### Why a DAW and not another node graph

Node-graph builders (LangGraph Studio, Flowise, n8n) show *dependencies*. They hide *time*: which agents run in parallel, which run in sequence, how many loop passes happen, and where the run spent its tokens. Music software solved the same problem decades ago with three separations, and AgentLoops keeps all three:

1. **Sequencing is separate from routing.** Patterns decide *when* a channel runs, and the mixer decides *where* its output goes. You can rearrange a run without rewiring it, and rewire it without rearranging it.
2. **Sources are separate from processing.** Generators (agents) produce output, and effects (processors such as compressors, gates and validators) transform it. Context compression, validation and guardrails go on a bus once instead of inside every prompt.
3. **Arrangement is separate from content.** A pattern is written once and placed many times, and editing it updates every placement, the way linked clips work in FL.

You get a run you can *see* (the playhead moving across the timeline), *scrub* (time-travel through a recorded take), *loop* (iterate on one pattern), *solo* (run one agent in isolation) and *bounce* (freeze an expensive agent's output so you stop paying for it while you edit downstream work).

**Built to be driven by agents.** You can make a whole song from Claude Code or any other AI harness, without opening the studio. The harness either talks to AgentLoops over MCP, or edits the JSON project file and calls the CLI (§10.4). The studio is where a human watches the run, scrubs takes and fine-tunes what the agent built.

AgentLoops is controlled **from outside**. It doesn't ship an agent of its own that must drive it. An optional built-in Assistant exists as an alternative for users without a harness. It's simply one more MCP client of Studio MCP, with the same tools, scopes and budgets as any outside harness, and no private API.

---

## 2. Goals and non-goals

### Goals
- G1. Compose multi-agent workflows visually on a timeline, with parallelism and sequencing that are obvious at a glance.
- G2. Iterate cheaply: loop a pattern, play from any position, reuse cached results, and bounce finished parts.
- G3. Show every run in full: tokens, cost, latency and frames per channel and per bus, and let users scrub recorded runs.
- G4. Make agent loops (write, critique, revise until approved) a native construct.
- G5. Ship the same project headless: `agentloops render` for batch runs, `agentloops serve` for an HTTP API, and `serve --mcp` for an MCP server.
- G6. Provide an open plugin model: agents, processors and controllers in any language, and tools through MCP.
- G7. **Harness-first.** A song can be made start to finish from Claude Code or any AI harness, through MCP or through the project file plus the CLI, without the UI (§10.4). An outside harness is the primary way to control AgentLoops, and a built-in assistant is optional, never required. Agents running inside a project also get MCP tools for the studio (§10.3).

### Non-goals (v1)
- Hundreds of SaaS connectors. Connectors come from MCP servers, and AgentLoops does not maintain its own.
- Model training or fine-tuning.
- Real-time multi-user co-editing. Projects are git-friendly files instead.
- A chat product. Chat is one possible input trigger, not the interface.
- Audio. The DAW metaphor shapes the UX only.

---

## 3. Users and example projects

**Users:** AI engineers building agent pipelines, prompt engineers tuning loops, and ops teams running agents on a schedule or on demand.

Five reference projects drive the design. Every feature in this spec should serve at least one of them.

| # | Project | Key mechanics exercised |
|---|---|---|
| P1 | **Draft → Critique → Revise** until the critic approves (max 5 passes) | Pattern loop with an `until` condition, sidechain gate, persistent context |
| P2 | **Research report**: 4 parallel researchers, then a writer, then an editor | Chords for fan-out, compressor on the research bus, join alignment, bounce |
| P3 | **Nightly repo maintenance**: triage issues, fix, review, open PRs | Clocked mode, a dataset clip sliced one issue per step, an approval processor, budget limiter |
| P4 | **Live support desk**: webhook tickets go to triage, then specialist agents, with escalation | Performance mode, external triggers, follow actions, human channel |
| P5 | **Eval sweep**: one pattern × 20 parameter variants, judged and compared | Randomize tool, takes and comping, judge meter on Master, arrangements A/B |

### 3.1 Walkthrough: P1 in 90 seconds (the "hello world")

1. Drag **Writer**, **Critic** and **Editor** agent presets from the Browser into the Agent Rack.
2. In pattern "Draft loop" (16 steps), light Writer step 1, Critic step 9 and nothing for Editor.
3. Route Writer to bus 1 "Draft" and Critic to bus 2 "Review". Set Critic's input to *listen* to bus 1 and Writer's input to listen to bus 2, so Writer sees the last review.
4. On bus 1, add a **Gate** processor with its sidechain from bus 2. The gate opens only when `side.last.json.approved == true` and sends to bus 3 "Final".
5. In pattern settings, set **Loop: until `bus("Review").last.json.approved` · max 5**.
6. In the Playlist, place "Draft loop" and then an Editor pattern. Editor listens to bus 3. Press **Space**.

The playhead loops the pattern. Each pass shows as a numbered take under the clip. When the critic approves, the playhead moves on to Editor, and Master receives the edited draft. The toolbar shows **$0.41 · 3 passes · 52 s**.

---

## 4. Concept map (FL Studio → AgentLoops)

| FL Studio | AgentLoops | Notes |
|---|---|---|
| Channel Rack | **Agent Rack** | Lists the channels used by the current pattern, with filter groups |
| Channel / generator plugin | **Agent channel** / generator | LLM agent, script, human, remote agent, replay, sub-project |
| Step Sequencer | **Step Sequencer** | Each lit step runs the channel's default instruction once |
| Step graph editor (velocity, pan, pitch per step) | **Step graph** | Per-step effort, temperature, instruction key, shift |
| Piano Roll | **Piano Roll** (also called the Task Roll) | Rows are named **instructions**, not pitches (like a drum map) |
| Note (velocity, pan, release, slide…) | **Task note** | Velocity = effort, pan = temperature, slide = continue the previous conversation |
| Chord | **Fan-out** | Stacked notes run as parallel instances |
| Pattern | **Pattern** | Reusable sub-routine across channels, can loop |
| Pattern mode / Song mode (`L`) | **Pattern / Song** toggle | Loop the current pattern or play the arrangement |
| Playlist, tracks, clips | **Playlist** | Pattern clips, data clips, automation clips |
| Audio clip | **Data clip** | A file, dataset, text or recorded output, played into a bus |
| Slicex / sliced audio | **Dataset slicing** | One dataset item per step |
| Arrangements (multiple) | **Arrangements** | Alternative orderings of the same material, for example "cheap" and "full" |
| Markers (loop, start, time) | **Markers** | Loop markers with `until` and `max`, checkpoints, sections |
| Mixer insert track (dynamic in FL 2025, up to 500) | **Bus** | Receives frames from channels and clips, created on demand |
| Effect slot / effect plugin | **Processor** | Compressor, gate, limiter, validator, router… |
| Sends / routing | **Sends** | Per-send mode: `all`, `final` or `summary` |
| Sidechain | **Sidechain** | One bus controls a processor on another bus |
| Master | **Master** | The deliverable, with output targets (return value, file, webhook) |
| Plugin delay compensation | **Join alignment** | Merges wait for all sources and order them deterministically |
| Smart disable | **Smart disable** | A processor with no input never runs and costs nothing |
| Freeze / render in place | **Bounce** | Records a channel's or bus's output to a data clip and mutes the source |
| Automation clip | **Automation clip** | Any parameter changes over time |
| Event editor | **Event editor** | Raw list of automation points and recorded frames |
| Link to controller | **Link to controller** | Binds a parameter to a trigger field, metric or controller |
| Formula Controller | **Formula controller** | Expression-driven parameter |
| Peak Controller | **Meter controller** | A stream metric becomes a control signal |
| Patcher | **Patcher** | Node graph inside one channel or processor slot |
| Layer channel | **Layer channel** | One trigger fires several channels (ensemble) |
| Performance Mode / Performance Zone | **Performance mode** | Live clip launcher for ops, inside the same Playlist |
| MIDI input / controller | **Triggers** | Webhook, cron, file watch, chat, CLI |
| Voice / polyphony | **Voice** / **polyphony** | A running agent instance and the per-channel concurrency limit |
| CPU meter | **Cost meter** | Dollars and tokens, live, against budget |
| Edison | **Tracer** | Take inspector, editor and fork point |
| Browser / plugin database | **Browser** / plugin database | Agents, instructions, tools, datasets, takes, templates |
| `.flp` / `.fst` | `.alp.json` / `.alpreset.json` | Plain JSON, git-diffable |
| Render (Ctrl+R) / stems | **Render** / **stems** | Headless run, with per-bus outputs as stems |
| Gopher (FL 2025) / Loop Starter (FL 2025) | **Assistant** / **Starter** (optional) | A built-in Studio MCP client for users without a harness. It answers from the AgentLoops manual, like Gopher, and builds a first pattern from a goal, like Loop Starter |
| Stem separation | **Trace separation** | Imports an existing agent log and splits it into channels |

---

## 5. Core model

### 5.1 Frames: what flows on the wires

Everything that moves between channels, buses and processors is a **Frame**.

```ts
type Frame = {
  id: string;            // ulid
  runId: string;
  voiceId?: string;      // the agent instance that produced it
  pos: { bar: number; tick: number };   // timeline position of the producing note
  source: { channel?: string; bus?: string; processor?: string; clip?: string };
  kind: "message" | "event" | "artifact" | "tool_call" | "tool_result" | "error" | "control";
  final?: boolean;       // marks the voice's final answer
  role?: "assistant" | "user" | "system";
  text?: string;
  json?: unknown;        // structured payload (validated if a schema is set)
  artifact?: { uri: string; mime: string; bytes: number };
  trust: "trusted" | "untrusted";       // tool results, data clips and web content are untrusted
  meta: { model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; latencyMs?: number };
};
```

A stream's **level** is its throughput. Meters show tokens, cost, frame count and error count per bar.

### 5.2 Time model

The grid follows FL Studio: **bars → beats → steps → ticks**. The defaults are 4 beats per bar, 4 steps per beat (16 steps per bar) and 96 PPQ (384 ticks per bar).

Agents don't take a fixed amount of time, so the clock has two modes.

#### Barrier mode (default)

Positions express **order**, not duration. The rule:

> **A note that starts at position *t* waits for every note that ends at or before *t*.** Then it starts.

- Notes that overlap run **in parallel**. Notes placed one after another run **in sequence**.
- A long note that spans others is a **background agent**: it runs alongside them, and its end acts as a join.
- Empty grid takes no wall time. The playhead jumps to the next start whose dependencies are done.
- A note counts as *done* when its voice has finished **and** its frames have settled through the mixer (processor "tails").
- **Sync scope:** the barrier is project-wide by default. A playlist track can be set to **Free**, so its clips wait only for earlier clips on the same track. This keeps unrelated lanes from blocking each other.

The transport shows the logical position (`3:09:00`) and the elapsed wall time. After a run, the **Actual timing** overlay stretches each clip to its real duration as a Gantt view.

**Playback pace.** Positions express order, but a studio needs to *feel* like it's playing. So studio Play treats the tempo (`clock.bpm`, default 120) as a **speed limit**: a barrier at tick *t* releases no earlier than `start + t × msPerTick`. Fast agents (scripts, cached voices) play at tempo, and the playhead sweeps. Slow agents hold the playhead, and it visibly stalls on the notes it's waiting for. `render`, `serve` and plain `run_start` run unpaced. A harness passes `pace: "project"` when the user is watching.

#### Clocked mode

Tempo maps bars to wall time. For example, "1 bar = 1 h" or a conventional BPM. Notes start at their scheduled wall time, and a note's length is its **deadline**. A voice that overruns is flagged red and handled by the channel's **late policy** (`queue`, `skip` or `cancel`). Use clocked mode for monitoring loops and nightly jobs (P3). A looping pattern in clocked mode is a periodic job.

#### Loops

- **Pattern mode** loops the current pattern: forever, N times, or `until <expr>`. In the studio, **PAT Play repeats until Stop**, as in FL. Each repeat is a fresh, paced run of the pattern (with its own `until`/`max`) using `cache: "prefer"`, so edits made while it plays land on the next repeat, and unchanged voices replay for free. This is the tweak-while-it-loops workflow.
- **Loop markers** in the Playlist do the same for a region of the arrangement (`until`, `max`).
- Every pass increments `loop.index` (0-based) and records a new **take** (§9). `max` is the number of passes, so `max: 5` runs passes 0–4.
- The `until` condition is evaluated at the barrier at the end of the loop.

#### Conditions on notes and clips

FL Studio has no branching, so this part borrows Elektron's trig conditions and Ableton's follow actions. Every note and clip can carry a condition:

| Condition | Meaning |
|---|---|
| `always` (default) | Runs every time |
| `when: <expr>` | Runs if the expression is true at the note's start |
| `pass: "1:2"` | Runs on the first pass of every 2 (iteration-based) |
| `prob: 0.3` | Runs with probability 0.3 (seeded) |
| `pre` / `!pre` | Runs if the previous conditional note on this channel ran / didn't run |

A skipped note counts as instantly done. Data-dependent routing (send this frame to bus A or bus B) is the **Router** processor's job (§5.7), not a timeline job.

### 5.3 Agent channels

A channel is an agent **definition**. A **voice** is one running instance of it, the way an FL note plays a voice of an instrument.

```ts
type Channel = {
  id: string; name: string; color: string; group?: string;   // group = filter group
  generator: { plugin: string; params: Record<string, unknown> };  // e.g. "llm.agent"
  keymap: Instruction[];      // rows of the piano roll (§5.4)
  inputs: InputSpec[];        // buses this channel listens to
  context: "fresh" | "persistent" | "per-pattern";  // conversation lifetime across notes
  output: string;             // bus id; unrouted channels go to Master
  polyphony: number;          // max concurrent voices (default 4)
  retries: number;            // default 1, exponential backoff
  onFail: "stop" | "skip" | "fallback";
  fallback?: string;          // channel id to use on failure
  latePolicy?: "queue" | "skip" | "cancel";   // clocked mode only
  mute: boolean; solo: boolean;
};

type InputSpec = {
  bus: string;
  window: "last" | "pass" | "run" | { lastN: number };  // which frames
  select: "final" | "all";
  as?: string;                // name used in templates: {{inputs.review}}
};
```

**Built-in generators**

| Plugin | What it is |
|---|---|
| `llm.agent` | Model, system prompt, tools (MCP), effort, temperature, max tokens, output schema. Runs a tool loop until it produces a final answer. |
| `script` | A JS/TS or Python function (sandboxed), for deterministic steps. |
| `human` | Posts a card to the **Inbox** panel and waits for an operator's reply, with a timeout. |
| `harness` | The outside harness driving the run (Claude Code over Studio MCP) is the agent. The run pauses, the harness does the work under its own login, and it replies with `voice_reply` (§10.4). No API key and no per-voice cost. It only works in runs started over Studio MCP. |
| `remote.agent` | A remote agent over HTTP/A2A. |
| `replay` | Plays back recorded frames from a take. Used for mocking and testing (the "sampler"). |
| `project` | Nests another `.alp.json` as an instrument. Its Master becomes this channel's output. |
| `layer` | Fires several child channels at once, as an ensemble. |

**Context assembly for a voice.** The prompt is built from the channel's system prompt, the instruction for the note's key, the note's text, the inputs, memory reads and the tools. Inputs are snapshots of frames from **completed** voices taken when the voice starts, rendered as tagged blocks:

```
<input bus="Review" from="Critic" pass="2" trust="trusted">…</input>
```

Because inputs are snapshots taken at start and only the playhead starts voices, feedback (Writer ↔ Critic) can't recurse infinitely. Loops always go through the timeline, where they're bounded by `max`.

**Rack controls per channel** (left to right, as in FL): mute LED, effort knob, temperature knob, polyphony, name button, step row, output bus number. Every knob can be automated. Right-click a knob → *Create automation clip* / *Link to controller*.

### 5.4 Instructions, keymaps and notes

FL lets you name piano-roll keys, and drum maps work the same way. In AgentLoops each piano-roll **row is an Instruction**:

```ts
type Instruction = {
  key: number;           // row index; 60 ("C5") is the default
  name: string;          // "Draft", "Revise", "Summarize"
  template: string;      // "Revise the draft using {{inputs.review}}. {{note.text}}"
  schema?: JSONSchema;   // optional structured output
};
```

Steps in the Step Sequencer always use the default key 60. The Piano Roll gives full control.

**Task note**

| Property | FL meaning | AgentLoops meaning |
|---|---|---|
| key | pitch | which instruction runs |
| start / length | position, duration | order and barrier (barrier mode) or deadline (clocked mode) |
| velocity | how hard | **effort**: reasoning effort or token budget, 0–1 |
| pan | left/right | **temperature**: left = precise, right = creative |
| release | release time | grace period after `length` before a timeout (clocked mode) |
| mod X / mod Y | user-mappable | user-mappable to any generator parameter |
| fine pitch | detune | **seed offset** for variants |
| color | MIDI channel/group | tag, for filtering and selection |
| slide | glide into the next note | **continue the previous voice's conversation** (legato) |
| text | (no FL equivalent) | per-note arguments, available as `{{note.text}}` |
| condition | (no FL equivalent) | §5.2 conditions |

**Chords** (stacked notes on one channel at the same start) are fan-out: N parallel voices, each with its own key, text and seed. Their outputs merge on the channel's bus, ordered by the bus's join mode.

**Piano Roll tools**

| Tool | Effect |
|---|---|
| Draw / Paint / Delete / Mute / Slice / Select / Zoom | Same as FL |
| **Chop** | Splits a note into N notes. Each gets `{{chunk.index}}` and `{{chunk.count}}`, for splitting a task into parts. |
| **Arpeggiate** | Turns a chord (parallel) into a run of notes (serial) |
| **Strum** | Staggers chord starts: by wall-clock gap in barrier mode, by grid offset in clocked mode. Useful for rate limits. |
| **Quantize** | Snaps starts and ends to the grid |
| **Glue** | Merges consecutive notes into one task |
| **Randomize** | Spreads velocity, pan and seed for variant sweeps (P5), seeded |
| **Ghost notes** | Shows other channels' notes in grey |
| **Highlight instructions** | Dims rows that have no instruction (the scale-highlighting analogue) |
| **Riff** (optional assistant) | Generates a note sequence from a description |

### 5.5 Patterns

A pattern holds, for any number of channels, step rows and/or piano-roll notes, plus a length and loop settings. Patterns contain **no routing**. Routing is global and lives in the mixer.

- Pattern clips in the Playlist are **linked**: editing the pattern updates every clip. **Make unique** forks a copy.
- A pattern clip can be trimmed to play only part of the pattern, or extended, in which case the pattern repeats.
- **Split by channel** turns one pattern into one pattern per channel.
- Loop settings: `{ max?: number; until?: Expr }`, used in Pattern mode and when the clip carries a loop marker.

### 5.6 Playlist, arrangements and clips

- **Tracks** are free lanes. Any clip can go on any track, as in FL. Each track has a name, color, mute, solo, lock, a **Free** sync toggle (§5.2) and an optional group.
- **Clip types**
  - **Pattern clip**: schedules the pattern's notes.
  - **Data clip**: emits frames into a chosen bus when the playhead reaches it. The source can be text, a file, a dataset (JSONL/CSV) or a recorded take. Data clips at position *t* emit **before** voices at *t* start. **Slice** spreads a dataset across steps, one item per step (Slicex for data, used in P3).
  - **Automation clip**: a curve for one parameter (§5.8).
- **Markers:** Start, Stop, Section labels, **Loop** (region plus `until`/`max`) and **Checkpoint** (saves bus and memory state, and lets *Play from here* resume without replaying everything before it).
- **Arrangements:** a project holds several playlists that share the same channels, patterns and mixer. You switch between them from the toolbar. Typical use: "draft (cheap models)" vs "production", or an A/B for P5.
- **Play from here:** start playback at any position. Everything before the playhead comes from the **latest take's cached frames** at no cost. Clips edited since that take are outlined amber as *stale*, and the user chooses to replay the stale ones or use cached results.
- **Scrubbing a take:** with the transport stopped, dragging the playhead over a recorded run updates every bus inspector and meter to its state at that moment. This is time-travel debugging.

### 5.7 Mixer

The mixer has **Master** plus any number of **buses** (16 shown by default). Each bus has a name, color, input list, **10 processor slots**, sends, mute, solo, **record arm** and meters.

**Routing**
- A channel or data clip outputs to one bus. Unrouted output goes to Master.
- A bus with no `sends` field sends `all` to Master, the way every FL insert routes to Master by default. `sends: []` sends nowhere.
- **Sends** go from bus to bus, each with a mode: `all` (every frame), `final` (only final answers) or `summary` (passes through the bus's compressor first).
- **Sidechain sends** carry control data only. Every processor on the target bus sees them as `side`, and they never merge into the target's stream.
- Bus-to-bus routing must be **acyclic**. Cycles are a compile error, shown inline. Channel inputs aren't part of this graph (they're start-time snapshots), so agent feedback loops are always allowed.
- **Join mode** per bus: `aligned` (default) holds frames until every source scheduled for the current barrier is done, then emits them in stable order (channel order, then note order). This is the PDC analogue, and it makes runs reproducible. `stream` passes frames through as they arrive.

**Built-in processors**

| Processor | Audio analogue | What it does | Key params |
|---|---|---|---|
| **Compressor** | compressor | Summarizes the stream when it goes over a token threshold | threshold, target tokens, model, keep (`last N`) |
| **Limiter** | limiter | Hard cap on tokens or cost per bar or run | ceiling, action (`truncate`, `block`, `stop transport`) |
| **Gate** | noise gate | Passes frames only when a condition holds, on the frame itself or on the sidechain. With `hold: "pass"`, a failing frame waits and is re-checked whenever a sidechain frame arrives and at each barrier. Frames still held when the loop pass ends are dropped. | condition, hold (`none` or `pass`) |
| **Validator** | (none) | Checks a JSON Schema. On failure: drop, error, or send a **retry request** back to the source voice | schema, onFail |
| **Filter** | EQ | Removes content: regex, PII scrub, topic filter | rules |
| **Transformer** | saturation | LLM rewrite of each frame ("formal tone", "translate to DE") | prompt, model |
| **Formatter** | (none) | Templating or JSON extraction, no LLM | template |
| **Buffer** | delay | Batches N frames or everything up to the barrier, then emits one frame | size, flush |
| **Ensemble** | chorus/unison | Re-asks N times and votes (self-consistency) | N, vote (`majority`, `judge`) |
| **Judge** | meter / analyzer | LLM-as-judge: adds a score and emits it as a control signal and annotation | rubric, model |
| **Router** | crossover / splitter | Sends each frame to one of several sends by expression | cases |
| **Memory** | reverb | Writes frames to a memory store, with decay as TTL | store, TTL, key |
| **Approval** | (none) | Holds frames for human approval or editing in the Inbox | timeout, onTimeout |
| **Recorder** | Edison | Captures the stream to a data clip | — |
| **Script** | (custom) | User code: `(frame, ctx) => Frame[]` | code |

**Master** adds **output targets**: return value (headless and serve), file, webhook, and MCP tool calls such as "create PR" or "post message". Output targets with side effects require an Approval processor upstream unless the project marks them *auto-approve*.

**Smart disable:** a processor with no input never runs. **Bounce / freeze:** right-click a channel or bus → *Bounce*. This runs it once (or reuses the latest take), records the output as a data clip on a new track routed to the same bus, and mutes the source. *Unbounce* reverses it. This is the main way to stop paying for parts you've finished (P2).

**Meters** (per bus, live): tokens per bar, cost, frames, errors, p50/p95 latency, peak hold. Clicking a meter opens the bus inspector: the last frames, with the full JSON.

### 5.8 Automation and controllers

Every parameter has an address, for example `ch.writer/temperature`, `bus.draft/2.threshold` (slot 2) or `pattern.draft/loop.max`.

- **Parameter latching:** generator parameters are read **when a note starts** and stay fixed for that voice. Agents have no sample rate. A long voice can opt into re-reading parameters on every turn (`latch: "turn"`).
- **Automation clip:** points with `linear`, `hold` or `smooth` shapes, mapped to the parameter's range. Enum parameters (model choice) always use `hold`. Example: temperature 0.9 → 0.2 across the loop region, or "use the bigger model from pass 3 on".
- **Event editor:** a raw, editable list of automation points, and of a data clip's frames.
- **Link to controller:** bind any parameter to a trigger payload field, a metric, or a controller.
- **Formula controller:** `clamp(0.2 + 0.1 * loop.index, 0, 1)`. It has inputs `a`, `b`, `c` (knobs) plus the expression context.
- **Meter controller** (the Peak Controller analogue): turns a bus metric into 0–1 with attack/release smoothing. Example: "if the Judge score on Draft drops, raise Writer's effort."

**One expression language everywhere** for conditions, `until`, gates, routers and formulas: CEL, through an existing implementation (no custom parser). `loop` is a reserved word in CEL, so the engine renames it before parsing, and `loop.index` works as written. Context:

```
loop.index, loop.max, run.costUsd, run.elapsedMs, note.text, trigger.payload,
bus("Review").last           // last frame (text, json, meta)
bus("Review").frames         // frames in the current pass
meter("Draft").errors, meter("Draft").score
param("ch.writer/temperature")
```

### 5.9 Patcher

The Patcher is a node graph that sits inside **one channel or one processor slot**. Its nodes are generators and processors, and its edges carry frames (solid) or control (dashed). Execution inside it is **dataflow**: a node runs when its required inputs arrive. Chosen inner parameters are exposed as **macro knobs** on the channel.

Use it to package a composite agent, such as planner → executor → verifier, as one instrument and save it as a preset. It's also the familiar home for users who think in DAGs. Patcher graphs must be acyclic, except through a Buffer node with a max iteration count.

### 5.10 Performance mode (live ops)

As in FL, Performance mode lives inside the Playlist. Clips placed in the **Performance Zone**, left of the Start marker, become launcher cells, and each track plays one cell at a time. One project holds both the arrangement and the launcher, and no separate view is needed.

- **Trigger mode** per track, modelled on FL's Auto/Queue/Tolerant: `immediate`, `queue` (wait for the next barrier in barrier mode or the next bar in clocked mode), or `tolerant` (immediate if the trigger arrives just after a boundary, otherwise queued).
- **Follow actions** per cell, borrowed from Ableton because FL has none: next, previous, random, a specific cell, or stop, after N passes or when an `<expr>` is true.
- **Triggers** map to cells. Example: a webhook with `payload.priority == "P1"` launches the "Escalation" cell. The trigger payload is available as `trigger.payload`.
- **Live prompt bar** (FL's typing keyboard): type text, then press `Enter` to play it as a note on the selected channel right away.
- The **Inbox** shows pending `human` voices and Approval holds. P4 runs entirely from this view.

### 5.11 Memory

Memory stores are project resources: key-value (`kv`) or vector (`vector`), with a scope of `run`, `project` or `global`. Channels read from them through `inputs` (`{ memory: "facts", query: "{{note.text}}", k: 5 }`). The **Memory** processor writes to them. Run-scoped stores are kept in the take, so scrubbing and *Play from here* restore them.

---

## 6. User interface

The app is a single window with dockable, detachable panels and FL-style shortcuts. The default layout:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ File Edit Add Patterns View Options Tools │ PAT ▸SONG │ ▶ ❚❚ ■ ● │ 3:09:00  00:52 │ ⟳ │
│ Clock: Barrier ▾  Arr: Production ▾  Pattern: Draft loop ▾ │ $0.41 / $5.00 ▮▮▯▯▯ │ 3/12 ▣ │
│ Hint: Writer · temperature 0.70 · right-click to automate                               │
├────────────┬───────────────────────────────────────────────────────────────────────────┤
│ BROWSER    │ PLAYLIST — Production                         1    2    3    4    5    6 │
│ ▾ Agents   │ ▕ Data   │ [issues.jsonl ▮▮▮▮▮▮▮▮▮▮▮▮]                                   │
│   Writer   │ ▕ Main   │ [Draft loop  ×3 ⟳][Draft loop][   Edit    ]                      │
│   Critic   │ ▕ Auto   │  ╲___ temperature ___________                                    │
│ ▸ Instr.   │ ▕ Takes  │  ▂▃▅ ▂▄▆ ▃▅▇  (pass 1..3)                                        │
│ ▸ Tools    ├───────────────────────────────────────────────────────────────────────────┤
│ ▸ Datasets │ AGENT RACK — Draft loop · 16 steps                                         │
│ ▸ Takes    │ ◉ ◐ ◑ 4 [Researcher] ■□□□ □□□□ □□□□ □□□□  → 1                             │
│ ▸ Templates│ ◉ ◐ ◑ 1 [Writer    ] □□□□ ■□□□ □□□□ □□□□  → 2                             │
│ ▸ Plugins  │ ◉ ◐ ◑ 1 [Critic    ] □□□□ □□□□ ■□□□ □□□□  → 3                             │
│            │ +                                                                          │
└────────────┴───────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Panels

| Panel | Key | Content |
|---|---|---|
| **Playlist** | F5 | Tracks, clips, markers, take lanes, actual-timing overlay, arrangement selector |
| **Agent Rack** | F6 | Channels for the current pattern, step rows, filter groups, add-channel menu |
| **Piano Roll** | F7 | Instruction rows, notes with text badges, property lanes (effort, temperature, mod X/Y), ghost notes, tools |
| **Plugin picker** | F8 | Searchable plugin database |
| **Mixer** | F9 | Bus strips, slots, sends matrix, meters, bus inspector |
| **Browser** | Alt+F8 | Library tree, search, tags, **audition** (runs a preset on a sample input in a sandbox) |
| **Tracer** | F10 | Take inspector (§9.2) |
| **Inbox** | F11 | Human voices, approvals, escalations |
| **Event editor** | — | Opened from any automation or data clip |
| **Undo history** | — | Every edit, click to jump |

**Piano Roll**

```
┌ PIANO ROLL — Writer ── tools: ✎ 🖌 ✂ ⌫ ⊘ ▭ 🔍 │ Chop Arp Strum Quantize Glue Rand ─────┐
│ Summarize │                                                                          │
│ Revise    │            [Revise: tighten intro ]                [Revise ]             │
│ Draft  C5 │ [Draft: {{inputs.brief}}]                                                  │
│ Outline   │ [Outl][Outl][Outl][Outl]  ← chord = 4 parallel voices                      │
│───────────┼───────────────────────────────────────────────────────────────────────────│
│ Effort    │ ▇▇▇▇        ▅▅▅▅                         ▃▃                               │
│ Temp      │ ▂▂▂▂        ▅▅▅▅                         ▂▂                               │
└───────────┴───────────────────────────────────────────────────────────────────────────┘
```

**Mixer strip**

```
┌ 2 Draft ─────┐
│ ▮▮▮▮▮▯▯ 1.2k │  tokens / bar
│ $0.08  ⚠0    │
│ 1 Compressor │
│ 2 Validator  │
│ 3 Gate ◀SC 3 │  sidechain from bus 3
│ 4 —          │
│ → 4 Final  F │  send, mode = final
│ ◉ M S ● JOIN │  mute, solo, arm, join=aligned
└──────────────┘
```

### 6.2 Interaction rules
- **FL's window model.** The Playlist is the background window. Channel Rack, Piano Roll, Mixer, Tracer and Monitor float over it, and F5–F11 toggle them.
- **FL's mouse grammar everywhere.**
  - **Left-click** draws or places (a step, a note, or a clip of the selected pattern), and **right-click** deletes.
  - **Drag** moves, **dragging the right edge** resizes, and **Shift+drag** box-selects.
  - The **scroll wheel** turns knobs and number boxes (effort, output bus, tempo).
  - **Double-click** opens a note's properties, or a channel's window.
  - One drag is one undo step.
- **The Monitor is the speaker.** It shows what reaches Master, live, readable and colored by source channel. Click a mixer strip to monitor that bus instead. Notes and clips show a one-line preview of their latest output, the agent equivalent of a waveform preview.
- **Drag anything from the Browser:** an agent preset onto the Rack makes a channel, a dataset onto the Playlist makes a data clip, a processor onto a mixer slot inserts it, and a take onto the Playlist makes a data clip of that take.
- **Running clips** pulse. **Failed** notes and clips turn red, and hovering shows the error with a retry button. **Stale** clips get an amber outline. **Cached** clips show a ⧉ badge.
- **Live edits during playback** take effect at the next barrier (barrier mode) or bar (clocked mode), and never touch a voice that's already running.
- **Solo** a channel to run only it, with its inputs fed from cached takes.
- The **hint bar** always describes the control under the cursor, including its automation address.
- **Connected harnesses** appear in the toolbar, for example `⇄ Claude Code · edit`. Their edits flash briefly where they land, and Undo history shows the client's name next to each one, so the user can watch an outside agent build the song and step in at any point.
- Color, theme and density are adjustable. Every action is reachable by keyboard and screen reader. The editor canvases expose an accessible list view of notes and clips.

### 6.3 Shortcuts (FL-compatible where an equivalent exists)

**Same as FL:** `Space` play/stop · `L` pattern/song · `Ctrl+R` render · `F5` Playlist · `F6` Agent Rack · `F7` Piano Roll · `F8` plugin picker · `Alt+F8` Browser · `F9` Mixer · `Ctrl+Alt+Z` undo step back · tools `P` draw, `B` paint, `D` delete, `T` mute, `C` slice, `E` select, `Z` zoom, `S` slide (Piano Roll) / slip (Playlist) · Piano Roll `Alt+U` chop, `Ctrl+U` quick chop, `Alt+A` arpeggiate, `Alt+S` strum, `Alt+Q` quantize, `Ctrl+G` glue, `Alt+R` randomize, `Alt+E` riff.

**AgentLoops only:** `F10` Tracer and `F11` Inbox (in FL these keys open settings and song info) · `Ctrl+Shift+B` bounce selection · `Ctrl+Shift+U` make unique · `Ctrl+Z` undo · `Ctrl+Shift+Z` redo · `Esc` panic (stop every voice and cancel in-flight tool calls).

---

## 7. Execution engine

### 7.1 Pipeline

```
Project ──compile──▶ Plan ──schedule──▶ Voices ──frames──▶ Mixer graph ──▶ Master targets
                      │                    │                    │
                      └── validation       └── cache / replay   └── take recorder (every frame)
```

1. **Compile** the active arrangement (or the current pattern in Pattern mode) into a **Plan**: absolute-tick note events with their channel, key and condition, data-clip emissions, the automation lookup, and the bus graph. Validation errors (bus cycles, unknown parameters, missing secrets) show inline before play.
2. **Schedule** with the barrier algorithm (or clocked timers).
3. **Run voices**, each an async generator of frames, subject to polyphony and provider rate limits.
4. **Route** frames through bus processor chains and sends.
5. **Record** every frame, parameter latch and decision into the take.

### 7.2 Barrier scheduling

```
points = sorted unique(note starts ∪ note ends ∪ clip starts)
for t in points:
    await settled(v for v in voices if v.end <= t and inScope(v, t))  # done + mixer tails flushed
    flush aligned joins for barrier t
    emit data clips starting at t
    for note in notes starting at t (stable order):
        if evalCondition(note): spawn(note) via polyphony queue
        else: mark done
    if t is a loop end and not until(loop) and loop.index < max: rewind to loop start
```

The voice lifecycle is `pending → waiting → running → settling → done | failed | cancelled | timeout`.

### 7.3 Caching, determinism and replay
- **Cache key** per voice: `hash(generator config, instruction, resolved params, input frame hashes, seed, plugin version)`.
- A cache hit **replays** the recorded frames. It costs nothing and displays as ⧉. Policy per run: `prefer-cache` (editing default), `fresh` (render default), or `fresh-for-stale`.
- Seeds come from the project seed plus the note position plus the fine-pitch offset. Aligned joins make merge order stable. Providers aren't deterministic, but replaying a take always is.

### 7.4 Failure, budgets and safety at runtime
- **Retries** use exponential backoff and jitter. They're per channel, and Validator retry requests count toward them.
- **`onFail`:** `stop` halts the transport, `skip` emits an error frame and continues, `fallback` re-runs the note on the fallback channel.
- **Budgets:** project, run, channel and note limits (`$` and tokens), enforced *before* each model call using estimates and reconciled after. The toolbar cost meter turns amber at 80% and stops the transport at 100%, unless the user overrides.
- **Pause** finishes running voices and holds at the next barrier. **Stop** cancels voices. **Panic** also cancels in-flight tool calls.

### 7.5 Headless
The same engine runs in the CLI and the server (§10). The UI is just another client of the engine's event stream.

---

## 8. Plugin system

### 8.1 Interfaces

```ts
type ParamSpec = {
  id: string; name: string;
  type: "number" | "enum" | "bool" | "text" | "json";
  min?: number; max?: number; options?: string[]; default: unknown;
  automatable?: boolean;     // default true for number/enum/bool
};

interface Generator {
  id: string; version: string; params: ParamSpec[];
  run(voice: VoiceContext): AsyncIterable<Frame>;   // voice.signal aborts the run
}

interface Processor {
  id: string; version: string; params: ParamSpec[]; sidechain?: boolean;
  process(frame: Frame, ctx: ProcessorContext): AsyncIterable<Frame>;  // 0..n frames out
  flush?(ctx: ProcessorContext): AsyncIterable<Frame>;                // at each barrier
}

interface Controller {
  id: string; version: string; params: ParamSpec[];
  value(ctx: ControllerContext): number;   // 0..1
}
```

`VoiceContext` provides the resolved params, the assembled messages, tools, inputs, memory, `emit()`, the abort signal, a seeded RNG and a budget guard.

### 8.2 Packaging and isolation
- **In-process** plugins are TypeScript modules (built-ins and trusted plugins).
- **Out-of-process** plugins communicate with JSON-RPC 2.0 over stdio (`run`, `process`, `flush`, `value` as streaming notifications). They can be written in any language, with a Python SDK provided. A crash kills only the plugin's voice. This is the analogue of FL's plugin wrapper bridging.
- **Tools** are MCP servers, configured per project and allow-listed per channel.
- **Manifest** `agentloops.plugin.json` holds id, version, kind, entry, params and required permissions (`network`, `fs:read`, `fs:write`, `exec`).
- The **plugin database** scans installed plugins and groups them by kind and category, with favorites. Presets are `.alpreset.json` files holding plugin id, version and params. Patcher presets embed their whole graph.

---

## 9. Takes, recording and the Tracer

### 9.1 Takes
- Every run, and every loop pass, is a **take**: frames, parameter latches, condition outcomes, voice timings, costs and errors.
- Takes appear as **take lanes** under playlist tracks. Each lane is a mini level graph of tokens over time.
- **Comping:** pick the best take per clip, for example "pass 2 for Draft, pass 3 for Review". The result is a comp that downstream *Play from here* uses. This drives P5.
- **Compare:** diff two takes side by side, with text diff on final frames and a parameter diff.
- **Promote:** turn a take or a selection into a data clip, or a `replay` channel for tests.

### 9.2 Tracer (Edison analogue)
- Opens a take or a single voice, with a timeline of frames, tool calls and errors. The "waveform" is tokens over time, colored by kind.
- From a selected region you can export it, make a data clip, or **Fork from here**. Forking edits a frame (for example, changes a tool result) and re-runs downstream voices from that point.
- Search spans all takes in the project: text, tool name, error type, cost.

### 9.3 Trace separation (import)
Import an external agent log (OpenTelemetry GenAI spans, or JSONL transcripts from common SDKs). AgentLoops splits it into channels by agent or role, builds a pattern that reproduces its timing, and adds a data clip of the original. This makes existing agents "remixable".

---

## 10. Render, serve, MCP and the CLI

```
agentloops studio [project]             # the studio in its own app window (Chromium --app), or a browser tab
agentloops render project.alp.json      # headless run of the active arrangement
    --arrangement production --input brief.md --cache fresh|prefer --budget 5
    --stems out/                        # write every bus's final frames as files
    --take out/take.jsonl
agentloops serve project.alp.json --port 8787   # POST /run {input} → Master output (sync or SSE)
agentloops serve project.alp.json --mcp         # expose the project as MCP tools (§10.2)
agentloops mcp [--scope read|edit|run]          # Studio MCP server over stdio (§10.1)
agentloops score project.alp.json [--pattern X] # text view of arrangement, patterns, mixer (§10.4)
agentloops init --harness claude-code|agents-md # new project + MCP config + agent skill file (§10.4)
agentloops validate project.alp.json [--json]   # compile only; non-zero exit on errors (CI)
agentloops test project.alp.json        # replay-channel run with assertions (see below)
```

- **Inputs:** the CLI/HTTP input becomes `trigger.payload` and also a data clip on the `Input` bus, at position 0.
- **Assertions:** a project can declare `tests: [{ input, expect: <expr over Master/buses> }]`. `agentloops test` runs them with `replay` channels (zero cost) or live (`--live`).
- **Triggers in serve mode:** webhooks (`/trigger/:name`), cron (clocked projects) and file watch, each mapped to an arrangement or a Performance-mode cell.

AgentLoops also *provides* MCP servers, on top of consuming them as tools. There are three, all built on the official MCP TypeScript SDK.

### 10.1 Studio MCP: let other agents drive AgentLoops

`agentloops mcp` runs an MCP server over stdio, or over streamable HTTP on localhost while the studio is open. An external agent, such as Claude Code, can build, run and debug projects with the same commands the UI uses. Every edit goes through the engine's command log. It shows up live in an open studio window, can be undone, and is labeled `via MCP · <client name>` in the undo history.

| Group | Tools |
|---|---|
| Project | `project_create`, `project_open`, `project_get` (full JSON or a summary), `project_validate` |
| Edit | `project_patch` (RFC 6902 JSON Patch, validated and applied atomically, which covers any field), `channel_upsert`, `instruction_upsert`, `pattern_edit` (steps and notes), `clip_place`, `bus_upsert`, `processor_insert`, `route_set`, `automation_set`, `undo` |
| Run | `run_start` (arrangement or pattern, cache policy, budget, input), `voice_reply` (answers `harness` voices), `run_status`, `run_stop` |
| Studio | `studio_status` (is a studio hosting this project?), `studio_focus` (point the user at a panel, channel, pattern, bus or voice), `studio_view` (what the user is looking at) |
| Inspect | `score_view` (§10.4), `take_list`, `take_get` (a summary, or frames filtered by bus, channel or kind), `take_compare`, `meter_get`, `bounce` |
| Library | `plugin_search`, `preset_search` |
| Inbox | `inbox_list`, `inbox_reply` (answers `human` voices only, §12) |

- **Resources:** `agentloops://project`, `agentloops://take/{id}`, `agentloops://bus/{id}` (subscribable during a live run), `agentloops://plugins` and `agentloops://manual/{topic}`.
- **Prompts:** `starter` (goal → first pattern) and `debug-take` (explain why a run failed, or why it cost what it did).
- **Long runs:** `run_start` with `wait: true` sends MCP progress notifications (position, pass, cost) and stops the run when the client cancels.
- **Scope:** the server starts with `--scope read|edit|run`. The default is `edit`, which allows reading and editing but no spending. `run` can spend money and is capped by `--budget`.

### 10.2 Project as an MCP server

`agentloops serve project.alp.json --mcp` exposes the project itself as MCP tools, so any agent can call a whole pipeline as a single tool.

- Each arrangement marked `export: true` becomes a tool named after it. Its input schema is the project's `input` JSON Schema (§11), and its result is Master's output: text, plus structured content when Master has a schema.
- Performance-mode cells marked `export: true` also become tools, for "launch this routine" calls.
- Progress notifications report position and pass, and cancelling the call stops the run.
- Each call records a take, which the studio shows like any other run.

### 10.3 Runtime MCP: tools for agents inside a run

Every run starts a built-in MCP server, `agentloops.runtime`. A channel adds it to its `tools` like any other server and allow-lists each tool individually. Every call is recorded in the take.

| Tool | What it does | Limit |
|---|---|---|
| `bus_read` | Reads more of a bus than the channel's input snapshot gave it | Only frames from completed voices, as in §5.3 |
| `memory_get` / `memory_put` / `memory_search` | Reads and writes the project's memory stores (§5.11) | Per-channel allow-list of stores |
| `emit` | Sends a progress or structured event frame to the channel's bus before the voice finishes | Counts toward the channel's budget |
| `ask_human` | Posts a question to the Inbox and waits for the reply | The channel's human timeout |
| `note_request` | Asks for a follow-up note (channel, instruction, text) | Placed at the next barrier on a **Spawned** lane, at most `maxSpawned` per run |
| `budget_left` | Returns the remaining run, channel and note budget | — |

`note_request` keeps the rule from §5.3: an agent never starts another agent directly. The request becomes a note on the timeline, the playhead starts it, and the per-run cap keeps it bounded. Spawned notes show up in the Playlist like any other note, so the user can see, mute or delete them.

### 10.4 Making a song from a harness

This is the reason the MCP servers exist. A whole song can be made start to finish from Claude Code or any other AI harness: channels, patterns, arrangement, mixer and tests. The user describes what they want, the harness builds and runs it, and the studio is optional, for watching and fine-tuning.

**Outside harness first, built-in assistant second.** The optional Assistant is a harness bundled with the app. It calls the same Studio MCP tools, under the same scopes and budgets. The rule that keeps the MCP surface complete: if the Assistant can do something, an outside harness can too, and nothing gets a private shortcut.

**The harness as the performer.** A channel whose generator is `harness` is played by the harness itself:

1. When the playhead reaches its note, `run_start` returns `status: "waiting"` with one request per waiting voice. A request carries the rendered prompt, the inputs (marked untrusted where they are), the output schema, the conversation history, and, on a validator retry, `feedback` explaining what to fix. A brief settle window lets every note of a chord arrive in one list.
2. The harness does the work, using subagents for parallel voices if it likes. Then it calls `voice_reply` with one entry per voice: `text`, `json` (checked against the schema immediately), or `error` to decline.
3. `voice_reply` resumes the run, and returns the next `waiting` list or the final result. The harness loops until the status is `done`.

Answers become ordinary frames, so validators, gates, loops, takes and the cache work unchanged. With `cache: "prefer"`, answers that already exist replay without asking again. Because the harness isn't blocked inside `run_start` while the run waits on it, the protocol can't deadlock. The cost is your own harness usage, so no API key is needed and AgentLoops never handles a subscription login. `render`, `serve` and studio-started runs have no harness to ask, so they fail harness voices with a clear message. Use `llm.agent` for those.

Both of the following paths can do everything:

| Path | What the harness needs | Best for |
|---|---|---|
| **MCP** (§10.1) | MCP support | Editing live while the studio is open, structured run feedback |
| **File + CLI** | File-edit and shell tools | Any harness, CI, git workflows |

The project is plain JSON (§11), and the CLI validates, runs, inspects and renders it, so a harness without MCP support loses nothing. An open studio hot-reloads the file when it changes on disk, so the user can watch the song being built either way.

**What makes this work for an agent**
- **Score view.** An agent can't see the Playlist. `score_view` (MCP) and `agentloops score` (CLI) render the arrangement, patterns and mixer as compact text so the agent can check what it built.
- **Positions in bars.** Notes and clips accept `"2:09"` (bar 2, step 9) instead of tick 576.
- **Actionable errors.** `project_validate` and `validate --json` return a JSON Pointer path, a message and a suggested fix for each error.
- **Cheap iteration.** Cache replay means a re-run after a downstream edit costs only the parts that changed. The agent can go through edit → run → read the take many times on a small budget.
- **A built-in manual.** The `agentloops://manual/{topic}` resources and the `starter` prompt teach the concepts and recipes, the way Gopher answers from FL's manual.
- **One-command setup.** `agentloops init --harness claude-code` creates the project, an `.mcp.json` entry for Studio MCP, and a skill file with the concepts and the authoring loop below. `--harness agents-md` writes an `AGENTS.md` for other harnesses.

**The authoring loop the skill teaches**

```
1. project_create, *_upsert, pattern_edit, clip_place   build it from the user's description
2. score_view + project_validate                         check the structure, fix errors
3. run_start (budget-capped)                             play the arrangement, or loop one pattern
4. take_get (summary)                                    outputs, cost and failures per channel
5. edit, repeat                                          unchanged parts replay from cache for free
6. add tests, then render or serve                       ship it
```

**Example.** In Claude Code, the user types: *"Make a song: three researchers look up a topic in parallel, a writer drafts from their notes, and a critic reviews until it approves, max 4 passes. Keep a run under $1."*

Claude Code creates the project and adds Researcher, Writer and Critic channels. It writes a "Research" pattern with a three-note chord and a "Draft loop" pattern with `until` and `max`, places both in the arrangement, adds a Compressor on the research bus and a Gate on the final bus, and validates. Then it runs with `budget: 1` and reads the take summary. Suppose the summary shows the critic never approves because its schema lacks `approved`. Claude Code fixes the instruction and re-runs, and the researchers replay from cache. It ends by reporting the draft and the cost. `score_view` at that point returns:

```
ARRANGEMENT Main               |1            |2
  Main                         |Research     |Draft loop ⟳ until approved, max 4
PATTERN Research · 16 steps
  Researcher → research        ■³·· ···· ···· ····   "history" "players" "risks"
PATTERN Draft loop · 16 steps
  Writer ← research,review → draft    ■··· ···· ···· ····   Draft | Revise
  Critic ← draft → review             ···· ···· ■··· ····   Review {approved, notes}
MIXER
  research  Compressor(8k→2k)
  draft     → final (final)
  review    Validator → final (sidechain)
  final     Gate(side.approved) → master
```

---

## 11. Project file format

A single pretty-printed JSON file with stable key order, so `git diff` reads well. Takes live next to it in `.agentloops/takes.sqlite`, which is gitignored by default. Secrets never live in the project. They're referenced by name and resolved from the OS keychain or the environment.

```json
{
  "format": "agentloops/1",
  "name": "Draft-Critique-Revise",
  "seed": 1234,
  "clock": { "mode": "barrier", "beatsPerBar": 4, "stepsPerBeat": 4, "ppq": 96 },
  "budgets": { "runUsd": 5 },
  "secrets": ["ANTHROPIC_API_KEY"],
  "input": { "type": "object", "required": ["topic"], "properties": { "topic": { "type": "string" } } },
  "tools": { "web": { "mcp": { "command": "npx", "args": ["-y", "some-search-mcp"] } } },
  "channels": [
    {
      "id": "writer", "name": "Writer", "color": "#e8a33d",
      "generator": { "plugin": "llm.agent", "params": {
        "model": "claude-sonnet-5-5", "system": "You are a concise technical writer.",
        "tools": [], "effort": 0.5, "temperature": 0.7 } },
      "keymap": [
        { "key": 60, "name": "Draft",  "template": "Write a draft about: {{trigger.payload.topic}}" },
        { "key": 62, "name": "Revise", "template": "Revise using this review:\n{{inputs.review}}" }
      ],
      "inputs": [ { "bus": "review", "window": "last", "select": "final", "as": "review" } ],
      "context": "persistent", "output": "draft", "polyphony": 1, "retries": 1, "onFail": "stop"
    },
    {
      "id": "critic", "name": "Critic", "color": "#5aa9e6",
      "generator": { "plugin": "llm.agent", "params": { "model": "claude-opus-5-5", "effort": 0.7 } },
      "keymap": [ { "key": 60, "name": "Review", "template": "Review the draft:\n{{inputs.draft}}",
                    "schema": { "type": "object", "required": ["approved", "notes"],
                                "properties": { "approved": { "type": "boolean" }, "notes": { "type": "string" } } } } ],
      "inputs": [ { "bus": "draft", "window": "last", "select": "final", "as": "draft" } ],
      "context": "fresh", "output": "review", "polyphony": 1, "retries": 1, "onFail": "stop"
    }
  ],
  "patterns": [
    {
      "id": "loop", "name": "Draft loop", "lengthSteps": 16,
      "loop": { "max": 5, "until": "bus('review').last.json.approved" },
      "notes": {
        "writer": [ { "start": 0, "len": 96, "key": 60, "vel": 0.5, "pan": 0.2, "when": "loop.index == 0" },
                    { "start": 0, "len": 96, "key": 62, "vel": 0.5, "pan": 0.0, "when": "loop.index > 0", "slide": true } ],
        "critic": [ { "start": 192, "len": 96, "key": 60, "vel": 0.7 } ]
      }
    }
  ],
  "arrangements": [
    { "id": "main", "name": "Main",
      "tracks": [ { "name": "Main" } ],
      "clips": [ { "type": "pattern", "ref": "loop", "track": 0, "start": 0, "len": 384 } ],
      "markers": [] }
  ],
  "mixer": {
    "buses": [
      { "id": "draft",  "name": "Draft",  "slots": [], "sends": [ { "to": "final", "mode": "final" } ], "join": "aligned" },
      { "id": "review", "name": "Review", "slots": [ { "plugin": "fx.validator", "params": { "onFail": "retry" } } ],
        "sends": [ { "to": "final", "mode": "sidechain" } ] },
      { "id": "final", "name": "Final", "slots": [
          { "plugin": "fx.gate", "params": { "condition": "side.last.json.approved" } } ],
        "sends": [ { "to": "master", "mode": "final" } ] }
    ],
    "master": { "targets": [ { "type": "return" } ] }
  },
  "automation": [],
  "controllers": [],
  "tests": [ { "input": { "topic": "CRDTs" }, "expect": "master.last.text.size() > 200" } ]
}
```

A position is either a tick count (384 ticks per bar, 24 per step) or a `"bar:step[:tick]"` string, 1-based like FL's display (`"2:09"` = bar 2, step 9). Both are valid in the file, and the studio keeps whichever form was written. The schema is published as JSON Schema with the app, and older `format` versions are migrated on load.

---

## 12. Security and permissions

- **Tool allow-lists per channel.** A channel can only call tools listed in its `tools` parameter.
- **Side effects need approval.** Tools and Master targets marked `sideEffect` (write file, open PR, send message) require an Approval processor upstream, or an explicit project-level *auto-approve* that the UI shows as a red badge.
- **Untrusted content.** Frames from tool results, data clips and remote agents are `untrusted`, which makes them visible in the Tracer. A channel with side-effect tools can be set to `acceptUntrusted: false`, so untrusted inputs are quarantined into a separate block that the model is told not to follow as instructions.
- **Sandboxing.** `script` generators run in a long-lived child process started with Node's permission model (no fs, no child processes, no worker threads or addons), and each call gets a fresh `vm` context with only `ctx` (as JSON), `setTimeout`/`clearTimeout` and the JavaScript built-ins: no `require`, `process`, `import()` or `fetch`. Results come back as JSON, a call is stopped after 30 s (the child is killed and respawned), and the child has a 256 MB heap. The ceiling: Node 24's permission model has no network switch, so a `vm` escape (a V8 bug) could still reach network modules, though not the file system or child processes; a container or network namespace is the upgrade. Python scripts and mixer processors are not implemented, and the processors that exist run no user code. Out-of-process plugins get only the permissions in their manifest, granted by the user on first load.
- **Secrets** live in the OS keychain or the environment, never in project files or takes. Takes redact known secret values.
- **Budgets** are hard limits enforced by the engine (§7.4), and the Panic key always works.
- **MCP servers AgentLoops provides (§10.1–10.3).** Studio MCP listens on stdio or localhost only, requires a per-client token over HTTP, and runs with an explicit scope (`read`, `edit` or `run`). Every run it starts is subject to budgets. An MCP client can answer `human` voices but can't grant Approval holds, unless the project sets `mcpApprovals: true`, which the UI shows as a red badge. Project-as-MCP uses the same auth as `serve`. The `run` scope means running sandboxed `script` code (see Sandboxing) and spending the budget, so grant it only to harnesses you trust with that budget. `agentloops init` grants it with a $1 budget cap. Runtime tools are allow-listed per channel, and their calls are recorded like any other tool call.
- **Audit:** every side-effect action is recorded in the take with its approver.

---

## 13. Architecture and stack

| Layer | Choice | Reason |
|---|---|---|
| Engine | TypeScript library (`@agentloops/engine`), Node ≥ 22 | Shared by UI, CLI and server. The agent and MCP SDK ecosystems are strongest in TS and Python. |
| UI | React + TypeScript. Playlist, Piano Roll and Step Sequencer on Canvas 2D with virtualized drawing. Panels in the DOM. | Canvas handles thousands of notes and clips. No game engine needed. |
| Shell (v1.0) | `agentloops studio`: a local HTTP + SSE server, shown in a Chromium `--app` window with its own profile (the studio quits when the window closes), else the default browser. A web app manifest, and `agentloops install` for the Linux app menu and `*.alp.json` files | Zero install friction, like Jupyter, but it looks and quits like an app |
| Shell (later) | Electron, with the engine in a utility process | Native menus, file associations, keychain. Same engine binary. |
| Storage | Project: JSON. Takes: SQLite (`better-sqlite3`), one DB per project | Diffable projects, queryable takes |
| Models | Anthropic SDK first-class, plus an OpenAI-compatible adapter for other providers | Wide coverage with two adapters |
| MCP | Official MCP TypeScript SDK, as client (tools) and server (§10.1–10.3) | One SDK for both directions |
| Expressions | CEL, through an existing JS implementation | Safe, side-effect-free, one language for conditions, gates and formulas |
| Undo | Command log over an immutable project model | Undo history panel for free |

**Engine ↔ UI protocol:** JSON over WebSocket. Commands go in (`edit`, `play`, `stop`, `seek`, `bounce`…), and events come out (`voice.*`, `frame`, `meter`, `barrier`, `take.*`). The UI never computes run state on its own. Studio MCP (§10.1) is a second adapter over the same commands and events, so anything the UI can do, an agent can do.

> **Slice 3 deviations.** The studio uses Server-Sent Events (`GET /api/events`) for server → browser and `fetch` POSTs for browser → server instead of a WebSocket. The UI is plain DOM plus Canvas 2D in type-stripped TypeScript (`ui/*.ts`, no framework, no build step) instead of React. `agentloops mcp` and `agentloops studio` are separate processes that sync through the project file (reload before edit) and the shared log `.agentloops/events.jsonl`.

**Studio as host (slice 5, after Blender MCP).** One live instance owns the state, and the MCP server only forwards:

```
Claude Code ⇐ MCP/stdio ⇒ agentloops mcp (relay) ⇐ HTTP + bearer token ⇒ agentloops studio (host: project, undo, runs)
```

- **The studio is the host.** When it opens a project, it writes `.agentloops/studio.json` (`port`, `token`, `pid`, `file`, mode 0600), and it removes the file on exit. It is the host for everything: the project, one undo history shared by every source with attribution, runs, and harness waits.
- **`agentloops mcp` is a relay.** On every tool call it checks for a live studio for that project file. If there is one, it relays the call to `POST /api/tool`, which streams NDJSON progress and the result, and cancels by aborting the request. If not, it runs the call on its own in-process host, the headless fallback that matches Blender's `*_for_cli` tools.
- **What this enables:** Play pressed in the studio works with `harness` channels, Undo is shared, and the agent can steer your view. The new tools are `studio_status`, `studio_focus` (show the user a panel or entity) and `studio_view` (what the user has open).

---

## 14. Roadmap

**Phase 0: "Loop box" MVP.** One pattern, one bus graph. Proves the core loop (P1).
- Agent Rack with Step Sequencer, and Piano Roll (instructions, notes, effort/temp lanes, chords, slide, text)
- Barrier clock, Pattern mode with `max` / `until`, note conditions (`when`, `pass`)
- Mixer: buses, sends, sidechain, aligned join, and processors Compressor, Gate, Validator, Limiter, Formatter
- Generators: `llm.agent` (Anthropic + OpenAI-compatible, MCP tools), `script`, and `harness` (the outside harness plays the channel, §10.4)
- Takes with cache replay, a basic Tracer (frame list plus voice timeline), the cost meter and run budget
- `agentloops studio`, `render`, `validate`
- Studio MCP (§10.1), `score`, `validate --json` and `init --harness` (§10.4). Studio MCP is a thin adapter over the engine protocol, so harnesses can make songs from day one.
- *Exit criteria:* P1 builds from scratch in the UI in under 5 minutes, and its second run costs $0 from cache. **Claude Code also builds and runs P1 from a one-paragraph prompt through Studio MCP alone, without opening the UI.**

**Phase 1: Song.** Arrangements (P2, P5).
- Playlist, tracks, pattern/data/automation clips, markers (loop, checkpoint), multiple arrangements
- Play from here, stale detection, scrubbing, bounce/unbounce, comping and take compare
- Browser with presets, audition, templates. Undo history. Piano Roll tools (chop, arp, strum, quantize, randomize).
- Processors Judge, Router, Buffer, Transformer, Filter, Approval. `human` generator and Inbox.

**Phase 2: Live and control.** (P3, P4)
- Clocked mode, Performance mode, triggers, follow actions, `serve`
- Automation-to-controller linking, Formula and Meter controllers
- Patcher, Layer channel, `project` (nested) and `replay` generators, `agentloops test`
- Out-of-process plugin protocol and Python SDK, memory stores
- Project as an MCP server (`serve --mcp`, §10.2) and the runtime MCP server for agents inside a run (§10.3)

**Phase 3: Ecosystem.**
- Electron shell, preset/plugin packs (marketplace), trace-separation import, OpenTelemetry export
- The optional built-in Assistant (Riff, Starter). It's a bundled Studio MCP client, built last because outside harnesses already cover its job.

---

## 15. Open questions

1. **Barrier scope default:** global (simple, can be slow) or per-track (fast, harder to reason about)? The draft says global, with a per-track Free toggle.
2. **Streaming inputs:** should a voice be able to read another *running* voice's partial output? The draft says no, because start-time snapshots keep runs reproducible.
3. **Pan → temperature:** is it a memorable mapping or forced? The alternative is generic mod lanes only.
4. **Cache correctness:** tool calls with external side effects or changing data (web search) make cached replays stale in ways the hash can't see. Should a per-tool `cacheable` flag default to false?
5. **Large fan-out:** a chord of 200 notes isn't usable in a Piano Roll. Is a "map over dataset" note property (one note expands to N voices) needed in Phase 1, or does dataset slicing cover it?
6. **Licensing and naming:** the UI borrows FL Studio's *concepts* and shortcuts, not its assets or trademarks. The final product name needs a trademark check.

---

## Appendix A: FL Studio research notes

Checked against Image-Line's manual and release notes on 2026-10-18. "Unconfirmed" means this pass found no primary source. Those rows describe standard FL features from prior knowledge, and nothing in the spec depends on their exact details.

| Topic | Finding | Status |
|---|---|---|
| Window keys | F5 Playlist, F6 Channel Rack, F7 Piano Roll, F8 Plugin Picker, Alt+F8 Browser, F9 Mixer, L pattern/song, Ctrl+R export WAV, Ctrl+Alt+Z undo step back [1] | Confirmed |
| Tool keys | P draw, B paint, D delete, T mute, C slice, E select, Z zoom. S is slide in the Piano Roll and slip in the Playlist [1] | Confirmed |
| Piano Roll tools | Chop Alt+U, Quick Chop Ctrl+U, Arpeggiate Alt+A, Strum Alt+S, Quantize Alt+Q, Quick Quantize Ctrl+Alt+Q, Glue Ctrl+G, Randomize Alt+R, Riff Machine Alt+E, plus scale highlighting [6] | Confirmed (from a manual search summary) |
| Arrangements | Multiple arrangements per project, added in FL Studio 20 (May 2018) along with rebuilt plugin delay compensation and in-situ rendering (freeze) [3] | Confirmed |
| Mixer | 10 effect slots per insert, sidechain and send routing. Smart Disable is a global setting that applies only during live playback [2] | Confirmed |
| Mixer size | FL Studio 2025 "Dynamic Mixer Tracks", up to 500 [5] | Confirmed |
| Formula Controller | Loaded in a mixer FX slot. Its 0–1 output appears in the Link to controller dialog [7] | Confirmed |
| Peak Controller | Follows its input's envelope to drive linked parameters [8] | Confirmed |
| Performance Mode | Lives in the Playlist. Clips before the Start marker form the Performance Zone, with one clip per track. Per-track triggering is Auto, Queue or Tolerant, and position sync is off, 1/4 to 4 beats, or auto [4] | Confirmed |
| Follow actions | Not in the FL docs, and a 2018 review says FL lacks them. The spec borrows them from Ableton. | Likely absent |
| FL Studio 2025 | Loop Starter (genre-based starter loops from FL Cloud sounds, placed in the Playlist), Gopher (in-app assistant that answers from the manual), Dynamic Mixer Tracks, Emphasis limiter, Mobile Rack, VFX Script, FL Studio Remote, Bassline Generator [5] | Confirmed |
| Stem separation, FL Cloud mastering | Third-party sources tie these to FL Studio 21.2 with FL Cloud. They aren't on the 2025 page [9] | Version unconfirmed |
| Ghost channels; note properties (velocity, pan, release, fine pitch, mod X/Y, color, slide, porta); Layer channel; filter groups; step graph lanes; channel polyphony; Event Editor; Patcher internals | The relevant manual pages returned 404s or index pages in this pass | Unconfirmed |

**Corrections applied to this draft:** FL's `Ctrl+U` is Quick Chop, so *make unique* moved to `Ctrl+Shift+U`. Quantize is `Alt+Q`, not `Ctrl+Q`. Performance mode now uses FL's Performance Zone and per-track trigger modes. Follow actions are credited to Ableton.

**Sources**
1. https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_shortcuts.htm
2. https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/mixer_plugin.htm
3. https://www.image-line.com/fl-studio-news/fl-studio-20-released
4. https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist_performance.htm
5. https://www.image-line.com/fl-studio-news/fl-studio-2025-whats-new-2
6. https://www.image-line.com/fl-studio-learning-content/fl-studio-online-manual/html/pianoroll_menu.htm
7. https://www.image-line.com/support/flstudio_online_manual/html/plugins/Fruity%20Formula%20Controller.htm
8. https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/automation_internal.htm
9. https://www.attackmagazine.com/news/fl-studio-2025-adds-ai-support-and-workflow-improvements-in-annual-update/
