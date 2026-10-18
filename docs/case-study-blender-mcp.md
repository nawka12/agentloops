# Case study: Blender MCP, and what AgentLoops should take from it

**Date:** 2026-10-18 · **Goal:** AgentLoops should be to agent workflows what Blender MCP is to 3D. It's a real application that people use, and an outside AI harness can drive it end to end.

Two projects are studied here:

| | **Blender Lab MCP server** (official) | **blender-mcp** (community) |
|---|---|---|
| Home | blender.org/lab/mcp-server · projects.blender.org/lab/blender_mcp | github.com/ahujasid/blender-mcp · PyPI `mcp-for-blender` |
| Status | Add-on 1.0.3, needs Blender 5.1+, last commit 2026-09-29, GPL-3.0+ | v2.1.9 (2026-10-06), about 31.5k stars and 2.9k forks |
| Philosophy | "deliberately small, maintainable, and does no more than necessary": understand and fix your scene | Feature-rich: build scenes fast with assets and AI 3D generation |
| Primary LLM | Any MCP client. The flagship guide uses **llama.cpp with a local model** | Claude Desktop and Claude Code, plus Cursor, Codex, VS Code and others |

---

## 1. How they work

Both projects use the same three-part architecture:

```
MCP client (Claude Code, llama.cpp…)  ⇐ MCP / stdio ⇒  MCP server process  ⇐ TCP localhost ⇒  add-on inside the running Blender
```

- **The running app is the source of truth.** An add-on inside Blender owns the scene and executes every request on Blender's main thread.
- **The MCP server is a thin relay.** The client launches it over stdio, and it forwards each tool call to the add-on over a localhost socket. It holds no scene state of its own.
- **The human watches the real app.** Every change lands in the Blender window the user already has open, with Blender's own undo, viewport and UI.

Implementation details worth copying:
- **Official add-on.** It polls its socket on a timer with *active* and *idle* intervals, so it doesn't load the UI when nothing is happening. It evicts stalled clients. It supports **deferred responses**: a long job such as a render holds the connection open while a lightweight checker polls for completion.
- **Official server: background `*_for_cli` variants.** Most read tools have one that opens a `.blend` file in background Blender. The same tools work without the UI running.
- **Community server.** It sends raw JSON over TCP on port 9876, serializes calls with a lock, has a 180 s timeout, and reconnects lazily after a failure.

## 2. The tool surfaces

**Official (about 24 tools, read-mostly):**
- **Understand:** `get_objects_summary`, `get_object_detail_summary`, `get_blendfile_summary_*` (data-blocks, missing files, linked libraries, path info, a "usage guess").
- **See:** `get_screenshot_of_window_as_image`, `get_screenshot_of_area_as_image`, and `get_screenshot_of_window_as_json`, which describes the window layout, areas, active object and selection as JSON.
- **Guide the human:** `jump_to_tab_by_name`, `jump_to_tab_by_space_type`, `jump_to_view3d_object_by_name`. **The agent can move the user's view to what it's talking about.**
- **Know the API:** `search_api_docs`, `search_manual_docs`, `get_python_api_docs`, over the Blender API reference and manual bundled as RST files.
- **Act:** `render_thumbnail_to_path`, `render_viewport_to_path`, and `execute_blender_code`. The connection prompt calls the last one a **"last resort, if there are other tools that provide the functionality you need, use those instead."**

**Community (9 model-facing tools, creation-first):**
- `execute_blender_code` (central)
- `look`: viewport, camera, multi-angle, wireframe/X-ray and animation strips, "so the AI checks its own work"
- `get_scene_info`
- `search_assets` and `import_asset`: Poly Haven, Sketchfab, Poly Pizza, with attribution stored on imported objects
- `generate_3d`: Tripo, Hunyuan3D, Rodin. It warns about credit cost and resumes pending jobs instead of paying twice.
- `get_addon_status`, `disable_telemetry`, `record_trajectory_feedback`
- Resources such as `blender://object/{name}`
- "App-only" tools for clients that support **MCP Apps**: an interactive viewport inside the client, where the user can pick a point on a screenshot.

## 3. How the model is taught the domain

The official server sends `prompts.yml` as instructions when a client connects. It opens with three rules:

> "Respect existing structure and naming conventions. NEVER assume missing values - inspect the scene first. Do not destructively modify objects without confirmation."

It then lists the gotchas that actually trip models in Blender: the current mode, active object versus selection, updating the dependency graph before reading computed values, flushing bmesh edits, data-block user counts, three kinds of visibility, and units. **These are domain pitfalls, not tool descriptions.**

The community server puts similar guidance in its server instructions: start with `get_addon_status`, look up shader nodes by type, and size imported models by their bounding box.

## 4. Safety, and how honestly each project describes it

- **Official.** "will execute LLM generated code in Blender without any guards in place", and it recommends a VM or a machine with no sensitive data. Its `weak_sandbox.py` says plainly that it "isn't really a sandbox … more of a slap on the wrist". It blocks only operations "guaranteed to cause problems", such as quitting Blender or a factory reset.
- **Community.** "ALWAYS save your work before using it." It warns that the socket "has no authentication or encryption … anyone who can reach that port can run Python inside Blender." An optional `BLENDER_MCP_SAFE_MODE=1` validates scripts and blocks file, OS, network and timer access.
- **Telemetry.** The community server collects anonymous usage by default; collecting content (prompts, code, screenshots) is opt-in. The README says the data may be used to train models. A fork advertising "telemetry removed, token auth added" exists, which shows users care. The official server describes no telemetry.

## 5. Distribution

- **Official.**
  - The add-on comes from Blender's extension repository, so it gets update notifications.
  - The MCP server ships as an **MCP Bundle (`.mcpb`)** for one-click install in clients that support it, or from source with `uv run blender-mcp`.
  - A minimal chat client is included.
- **Community.** `uvx mcp-for-blender setup` detects installed clients (Claude Desktop, Claude Code, Codex, Cursor, VS Code, OpenCode…) and writes their configs. Its troubleshooting section is mostly about installation (`spawn uvx ENOENT`, stale caches).
- **Testing.** The official repo has an end-to-end test that runs user input through the chat client, a real LLM (Anthropic or local llama.cpp), the MCP server and the add-on into headless Blender. It's skipped unless `BLENDER_BIN` is set.

---

## 6. Lessons for AgentLoops

### Already aligned
- **Harness-first.** The app is controlled from outside, and the built-in assistant is optional (§1 and §10.4 of the spec). Both Blender projects work this way.
- **Typed tools plus an escape hatch.** Upserts and `score_view` are the curated tools, and `project_patch` is the escape hatch. Ours edits data rather than running code, so it's safer than `execute_blender_code`.
- **Long operations.** Progress notifications, `wait: false` and the `voice_reply` pause/resume loop solve the same problem as Blender's deferred responses.
- **Works headless.** File + CLI and headless `agentloops mcp` correspond to the official `*_for_cli` tools.

### Changes, by priority

1. **The studio becomes the host, and `agentloops mcp` becomes a relay.**
   - Today the MCP process keeps its own copy of the project and runs its own engine. The studio is a second process, synced through the file and the event log.
   - Blender shows the better shape: **one live instance owns state; the MCP server only forwards.**
   - When a studio is open for the project, `agentloops mcp` should send every tool call to the studio's local API, using a token file in `.agentloops/` created with mode 0600. When no studio is open, it falls back to today's in-process engine, which is our `*_for_cli`.
   - What this gets us:
     - one writer, so no reload-before-edit races;
     - one undo history, with each edit labeled by its client;
     - **studio-started runs can use `harness` voices**, because the run lives in the studio and waiting voices reach Claude Code through the relay;
     - pressing Play in the studio and answering in Claude Code becomes possible.
2. **Navigation tools: `studio_focus`.** Add one tool, `studio_focus({panel, channel | pattern | bus | voice})`. The harness can then point you at what it just changed or at what failed ("look at the Critic in the Tracer"), like `jump_to_view3d_object_by_name`. It's cheap, and it's what makes a collaboration feel shared. A layout-as-JSON `studio_view` (what's selected and open) can come with it.
3. **Connection-time rules plus domain gotchas.**
   - Extend the Studio MCP `instructions` and the manual with three rules: **inspect first** (`project_get summary` and `score_view` before editing an existing song), **respect existing ids and naming**, and **confirm before destructive edits** (removing channels, patterns or buses, or rewriting a song you didn't create).
   - Then list *our* pitfalls the way `prompts.yml` does:
     - a channel only sees what a bus emitted at an earlier barrier;
     - `loop.max` is required, and it counts passes;
     - gates need `hold: "pass"` to wait for a later verdict;
     - `sends` omitted means Master, but `[]` means nowhere;
     - only `final` frames are read by default.
4. **Safety, stated as plainly as Blender does.**
   - A README and manual section saying that `script` channels run unsandboxed code, so `run` scope equals code execution.
   - A "weak guard" for script code in the spirit of `weak_sandbox.py`: block `process.exit`, `child_process` and writes outside the project directory, and label it honestly as a guard, not a sandbox.
   - The token on the relay (item 1), so we don't repeat the unauthenticated-socket mistake.
   - **No telemetry**, stated explicitly.
5. **Distribution.**
   - Publish the package, so `.mcp.json` uses `npx agentloops mcp` instead of an absolute path to `src/cli.ts`.
   - Ship an `.mcpb` bundle.
   - Grow `init --harness` into a `setup` that detects clients and writes configs for Claude Code, Claude Desktop, Cursor, Codex and VS Code.
6. **An opt-in end-to-end test with a real harness.** Running `claude -p` makes a song through Studio MCP from a one-paragraph prompt, skipped unless an env var is set. It measures our real product surface: the manual, the tool descriptions and the error hints. Blender Lab keeps the same kind of test.

### Later, or not needed
- **MCP Apps.** Embed the studio (or the score view) inside clients that support it, as the community viewport does. Promising once (1) exists.
- **Screenshots for the agent.** Blender needs pixels because geometry is visual. Our state is structured, and `score_view` plus JSON is the cheaper and more accurate "screenshot". Add `studio_screenshot` only if harnesses start needing to see the UI the way the user does.
- **Bundled searchable docs.** bpy is huge, but our manual is about 200 lines and one resource is enough. Topic resources and a search tool can wait until the manual outgrows that.
- **Local models.** The official server's llama.cpp focus fits the planned OpenAI-compatible adapter for `llm.agent` (llama.cpp serves that API). The `harness` generator already makes us harness-agnostic.
- **An asset store and generation.** The community project's growth came from Poly Haven, Sketchfab and AI 3D generation. Our equivalent is a preset and plugin library (agents, instructions, processors) that the harness can search and import. That's Phase 3 in the spec ("packs").

### Proposed roadmap change
Insert a new slice after the harness slice: **"Studio as host"**. It covers items 1–3: the relay with its token, `studio_focus`, and the new rules. It's the step that turns AgentLoops from a set of tools sharing a file into one live app an outside agent drives, which is how Blender MCP works.
