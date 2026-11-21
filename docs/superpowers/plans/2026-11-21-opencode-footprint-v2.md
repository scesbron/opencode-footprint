# opencode-footprint V2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the opencode-footprint plugin to the OpenCode V2 API on the fork `scesbron/opencode-footprint`, then upgrade its CO2 methodology to per-token-kind factors in an editable `factors.json`, then add GLM and Kimi model factors.

**Architecture:** Three sequential phases on separate branches. Phase 1 restructures the plugin into one V2 package directory (server part + TUI part) with pure logic moved unchanged. Phase 2 replaces the flat per-tier energy model with a three-term formula (input / cache-read at 0.08× / output) driven by an editable `lib/factors.json`. Phase 3 adds GLM/Kimi entries as model overrides in that file.

**Tech Stack:** TypeScript, `@opencode/plugin` 2.3.2 (V2 SDK), `@opencode/plugin/tui`, `@opentui/solid` (peer `>=0.6.6`), solid-js 1.9.12, `node:test` + Bun test, Bun lockfile.

**Spec:** `docs/superpowers/specs/2026-11-21-opencode-footprint-v2-design.md`

## Global Constraints

- Fork `scesbron/opencode-footprint`, V2-only: the V1 `server()` entrypoint, `tui.json`, and `@opencode-ai/plugin` are removed.
- Runtime target: OpenCode 2.3.1 (user's desktop). README states "OpenCode ≥ 2.0, tested with 2.3.1" (dated).
- All copy, docs, commits, and CHANGELOG entries in English. Conventional Commits (`feat`, `fix`, `docs`, `test`, `refactor`), no AI-attribution lines.
- Commits are gated per phase: the plan lists every commit message; the user gives one "ok" per phase before its commit steps run.
- Commands run from `.opencode/`: `bun install` (refreshes `bun.lock`), `npm run typecheck` (tsc), `npm test` (node --test, Node 24), `bun run test:bun`. CI runs typecheck + both test runtimes with `--frozen-lockfile`.
- Phase 1 must not change any number: existing pure-logic tests pass without touching expected values; only the V1 loader/tool-contract tests are rewritten for the V2 harness.
- Invoke the `green-claude` skill before the first implementation commit of each phase (user's global rule); TDD throughout (write failing test, watch it fail, implement, watch it pass).
- Pins: `@opencode/plugin` `2.3.2`; `@opentui/core` and `@opentui/solid` `>=0.6.6`; `solid-js` stays `1.9.12`; `@types/node` stays; `@opencode-ai/plugin` and the 0.4.5 `@opentui/*` pins are removed.
- Branches: Phase 1 `feat/v2-plugin` off `main`; Phase 2 `feat/energy-by-token-kind` off fork `main` (after Phase 1 merges); Phase 3 `feat/glm-kimi-factors` off the Phase 2 branch. Each phase merges to fork `main` only after the user's validation bloc + smoke test.

## Review Focus

1. **Model-override prefix collisions:** `glm-5.3-flash` must resolve to haiku-class, not be captured by the `glm-5.3` (sonnet) prefix — longest-override-key-first matching. Test in Phase 3 Task 1.
2. **User-edited `factors.json` is untrusted input:** malformed JSON or missing fields must fail loudly (throw) at load, never silently produce zeros or NaN. Test in Phase 2 Task 1.
3. **Weird/unknown model ids** (vendor-prefixed, date-suffixed, garbage) must fall back to a tier and never crash aggregation — existing `classifyModel`/`safeNumber` tests plus new resolution tests. Tests in Phase 2 Task 1 and Phase 3 Task 1.
4. **Failed history reads surface as an error message**, not an empty report (V1 behavior contract). Test in Phase 1 Task 2.
5. **Env overrides reject invalid values and fall back** (grid intensity already does; cache-read factor gets the same contract). Test in Phase 2 Task 1.

---

## Phase 1 — `feat/v2-plugin`: V2-only port, no number changes

### Task 1: Package scaffold, pure logic moved unchanged

**Files:**
- Create: `.opencode/plugins/co2-footprint/package.json`
- Move: `.opencode/plugins/lib/{co2-core,co2-report,co2-sidebar-logic}.ts` → `.opencode/plugins/co2-footprint/lib/` (contents unchanged)
- Delete: `.opencode/plugins/co2-tracker.ts`, `.opencode/plugins/co2-sidebar.tsx`, `.opencode/tui.json`
- Modify: `.opencode/package.json` (dependency swap), `.opencode/bun.lock` (via `bun install`), `.opencode/co2-tracker.test.ts` (imports; delete V1-contract and V1-tool tests)

**Interfaces:**
- Produces: the package dir layout later tasks build on. `package.json`:

```json
{
  "name": "opencode-footprint",
  "type": "module",
  "exports": { ".": "./index.ts", "./tui": "./tui.tsx" }
}
```

- `.opencode/package.json` dependencies become: `@opencode/plugin` `2.3.2`, `@opentui/core` `>=0.6.6`, `@opentui/solid` `>=0.6.6`, `solid-js` `1.9.12`; devDependencies unchanged except removing anything only the V1 entrypoint needed. Remove `@opencode-ai/plugin`.

- [ ] **Step 1: Move the lib files and update the test file's imports**

`import` paths in `.opencode/co2-tracker.test.ts` change from `./plugins/lib/co2-core.ts` etc. to `./plugins/co2-footprint/lib/co2-core.ts`. Delete these tests (their subject is gone, replacements come in Task 2): `every top-level server plugin file exports only a V1 default`, and the five `co2_report tool:` tests with their `loadTool`/`toolContext`/`run` helpers and the `PluginInput`/`ToolContext` imports. Keep every pure-logic test byte-identical.

- [ ] **Step 2: Swap dependencies**

Edit `.opencode/package.json` per the Interfaces block, then `bun install` from `.opencode/`.

- [ ] **Step 3: Run the suite and typecheck**

Run: `cd .opencode && npm test && npm run typecheck`
Expected: PASS — all remaining tests green with zero edits to expected values. Typecheck fails only on the missing `index.ts`/`tui.tsx`? No: the tsconfig glob covers the moved lib files; `index.ts` does not exist yet and nothing imports it. Typecheck must PASS. If it fails, fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add .opencode
git commit -m "refactor: move plugin logic into the co2-footprint package directory"
```

### Task 2: V2 server part — `co2_report` tool

**Files:**
- Create: `.opencode/plugins/co2-footprint/index.ts`
- Test: `.opencode/co2-tracker.test.ts` (add a V2 harness section)

**Interfaces:**
- Consumes: `buildSessionStats`, `buildReportData`, `formatReport` from `lib/co2-report.ts`; `getGridIntensity` from `lib/co2-core.ts` (unchanged signatures).
- Produces: default export `Plugin.define({ id: "opencode-footprint.co2-tracker", setup })` from `@opencode/plugin`. `setup(ctx)` registers one tool named `co2_report` via `ctx.tool.transform((editor) => editor.add({...}))`, with `input` a JSON Schema whose only property is the optional string enum `export: ["json", "markdown"]`. The executor: reads the session history with `await ctx.session.context({ sessionID: context.sessionID })`, adapts each entry via `const usage = (m: object) => ("info" in m ? (m as { info: unknown }).info : m)` (V1 consumed `m.info`; V2's `SessionMessageInfo` may be bare — the structural `UsageMessage` view tolerates both), then runs the unchanged report pipeline. On a rejected history call it returns the string `Could not read this session's messages: ...`. With zero assistant messages it returns the existing `NO_DATA_MESSAGE`. With `args.export` it writes `co2-report.json`/`.md` into `ctx.location.directory` (captured from `setup`'s `ctx`) and appends `*Exported to \`path\`*`. The tool description reuses the V1 text verbatim.

- [ ] **Step 1: Write the failing tests**

New harness (fake `ctx`), replacing the deleted V1 tool tests:

```ts
type AddedTool = { name: string; execute: (args: { export?: "json" | "markdown" }, ctx: unknown) => Promise<unknown> }

async function loadTool(history: () => Promise<unknown[]>) {
  const added: AddedTool[] = []
  const ctx = {
    location: { directory: "/unused" },
    tool: { transform: async (cb: (e: unknown) => void) => cb({ add: (t: AddedTool) => void added.push(t) }) },
    session: { context: async () => history() },
  }
  const plugin = co2FootprintPlugin as { id: string; setup(ctx: unknown): Promise<void> }
  await plugin.setup(ctx)
  assert.equal(plugin.id, "opencode-footprint.co2-tracker")
  assert.equal(added.length, 1)
  return added[0]
}
```

Restore the five V1 behaviors as tests against this harness (same assertions as the deleted ones): full resumed-session history reported (`history` fixture already in the file), re-read on every call (three snapshots), `No usage data recorded yet` when no assistant messages, `Could not read this session's messages` + error name when `session.context` rejects, and `export: "json"`/`"markdown"` writing `co2-report.{json,md}` into a `mkdtemp` directory (patch `ctx.location.directory` to the tmpdir). Plus one contract test: the package dir contains `package.json` with exports `.` and `./tui`, and no `.ts/.js` file sits at the top level of `.opencode/plugins/`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd .opencode && npm test`
Expected: FAIL — `./plugins/co2-footprint/index.ts` does not exist.

- [ ] **Step 3: Implement `index.ts`**

Per the Interfaces block. Keep all logic in `lib/`; `index.ts` is wiring only.

- [ ] **Step 4: Run to verify they pass**

Run: `cd .opencode && npm test && bun run test:bun && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode
git commit -m "feat: port the server plugin to the V2 plugin API"
```

### Task 3: V2 TUI part — sidebar

**Files:**
- Create: `.opencode/plugins/co2-footprint/tui.tsx`

**Interfaces:**
- Consumes: `computeSessionCo2`, `formatSessionLine`, `formatLifetimeLine` from `lib/co2-sidebar-logic.ts`; `getGridIntensity`, `summarizeLifetime`, `upsertLifetimeSession`, type `LifetimeSessions` from `lib/co2-core.ts` — all unchanged.
- Produces: default export `Plugin.define({ id: "opencode-footprint.co2-sidebar", setup(context) })` from `@opencode/plugin/tui`. One slot registration:

```tsx
context.ui.slot({
  append: "sidebar.footer",
  render: ({ sessionID }) => <Footer context={context} sessionID={sessionID} />,
})
```

`Footer` is a Solid component: `createMemo` over `context.data.session.message.list(sessionID)` → `computeSessionCo2(messages, getGridIntensity())`; persists this session's running total into the durable store `const [stored, updateStored] = context.storage.store("co2.lifetime.sessions", { initial: {} as LifetimeSessions })` via `updateStored((draft) => { draft[sessionID] = { grams, kwh } })` (upsert semantics, never accumulate deltas — same idempotency contract as V1); display value merges `stored` with the current session (speculative upsert, like V1). Renders nothing while `session().messages === 0` (`<Show>`). Skip persisting before the first assistant message (same rule as V1). Use `context.theme.text.base` (and a muted token from `context.theme` for the lifetime line — pick what typechecks). JSX runtime stays `@opentui/solid` (tsconfig already set).

- [ ] **Step 1: Implement `tui.tsx`**

Per the Interfaces block. Note: V2 `append` coexists with the built-in footer — no order juggling, the built-in footer survives (behavior change vs V1, goes to CHANGELOG in Task 4). `usePlugin()` is unnecessary here since `setup`'s `context` is closable.

- [ ] **Step 2: Typecheck**

Run: `cd .opencode && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .opencode
git commit -m "feat: port the sidebar to the V2 TUI API"
```

- [ ] **Step 4: User smoke checkpoint (before merge)**

After this phase's commits are approved and pushed: with `feat/v2-plugin` checked out in `~/dev/opencode-footprint`, run `cd .opencode && bun install`, then `/reload` in the user's desktop session here and invoke `/co2`; the report renders over this session's real history. The sidebar is TUI-only: the user verifies it once with `opencode` in a terminal opened at the repo root. Merge to fork `main` after both checks pass.

### Task 4: README, INSTALL, CHANGELOG for V2-only

**Files:**
- Modify: `README.md`, `INSTALL.md`, `CHANGELOG.md`, `.opencode/plugins/co2-footprint/lib/co2-core.ts` (header comment only — it describes the V1 loader glob)

**Interfaces:** none (docs).

- [ ] **Step 1: Update the docs**

README: requirements become "OpenCode ≥ 2.0, tested with 2.3.1"; project structure reflects the package dir; install steps drop the `tui.json` copy and merge-dependencies step stays; the "single winner sidebar" note is replaced by "appends beside the built-in footer". `lib/co2-core.ts` header comment: drop the V1 auto-glob rationale. CHANGELOG `[Unreleased]`: `### Removed` — V1 entrypoint, `tui.json`, OpenCode 1.x support; `### Changed` — plugin ships as one package directory auto-discovered by V2, sidebar appends instead of replacing the footer; `### Added` — V2 plugin API port. INSTALL keeps its tagged-release flow, with the new file list.

- [ ] **Step 2: Commit**

```bash
git add README.md INSTALL.md CHANGELOG.md .opencode/plugins/co2-footprint/lib/co2-core.ts
git commit -m "docs: document the V2-only install flow"
```

**Phase 1 gate:** present the four commit messages as one bloc → user "ok" → execute commits → push → smoke (Task 3 Step 4) → merge to fork `main`.

---

## Phase 2 — `feat/energy-by-token-kind`: methodology from claude-carbon

### Task 1: `lib/factors.json` + `lib/co2-factors.ts`

**Files:**
- Create: `.opencode/plugins/co2-footprint/lib/factors.json`, `.opencode/plugins/co2-footprint/lib/co2-factors.ts`
- Test: `.opencode/co2-tracker.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Factors {
  version: number
  cacheReadFactor: number
  families: Record<string, { input: number; output: number }> // Wh/Mtok, PUE included
  tiers: Record<"small" | "medium" | "large", { input: number; output: number }>
}
export function loadFactors(): Factors            // cached read of factors.json beside the module; throws on malformed/missing
export function getCacheReadFactor(env: NodeJS.ProcessEnv): number // OPENCODE_CO2_CACHE_READ_FACTOR override, invalid → factors.json value
export function resolveModelFactors(modelID: string, factors: Factors): { source: "family" | "tier"; label: string; input: number; output: number }
export function lifetimeStorageKey(factors: Factors): string // "co2.lifetime.sessions.v" + version
```

`factors.json` contents (numbers verbatim from the spec's table):

```json
{
  "version": 2,
  "cacheReadFactor": 0.08,
  "families": {
    "sonnet": { "input": 136, "output": 2878 },
    "haiku": { "input": 35, "output": 722 },
    "opus": { "input": 272, "output": 5756 }
  },
  "tiers": {
    "small": { "input": 35, "output": 722 },
    "medium": { "input": 136, "output": 2878 },
    "large": { "input": 272, "output": 5756 }
  }
}
```

Family resolution reuses segment matching like `classifyModel`: ids whose segments contain `sonnet`/`haiku`/`opus` map to the family; everything else falls to `classifyModel`'s tier.

- [ ] **Step 1: Write the failing tests**

`loadFactors` returns the exact table values; `resolveModelFactors("claude-sonnet-4-5")` → family sonnet (136/2878); `("glm-5.3")` → tier medium (Phase 3 overrides it); `("totally-unknown")` → tier medium; `("anthropic/claude-opus-4-5-20251101")` → family opus. `getCacheReadFactor` honors `OPENCODE_CO2_CACHE_READ_FACTOR` and rejects invalid (`"abc"`, `"0"`, negative) → 0.08. A malformed JSON file → `loadFactors` throws (use a temp copy of the module dir? No — test the internal parser directly: export nothing extra; instead assert that corrupting the parsed shape via a malformed fixtures file path makes the loader throw, by testing the loader against a fixture path parameter: make `loadFactors(path = defaultPath)` accept an optional path for testability). `lifetimeStorageKey(loadFactors())` ends with `.v2`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd .opencode && npm test`
Expected: FAIL — `co2-factors.ts` does not exist.

- [ ] **Step 3: Implement `co2-factors.ts` + `factors.json`**

Per the Interfaces block. `loadFactors(path?: string)` reads and JSON-parses, validates `version > 0`, `cacheReadFactor > 0`, and every family/tier entry has finite positive `input`/`output` — throws `Error("Invalid factors file: ...")` otherwise. Cache the default-path result.

- [ ] **Step 4: Run to verify they pass**

Run: `cd .opencode && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode
git commit -m "feat: load energy factors from an editable factors.json"
```

### Task 2: Per-kind energy computation

**Files:**
- Modify: `.opencode/plugins/co2-footprint/lib/co2-core.ts` (energy section), `lib/co2-report.ts`, `lib/co2-sidebar-logic.ts`, `.opencode/co2-tracker.test.ts`

**Interfaces:**
- Consumes: `Factors`, `resolveModelFactors`, `getCacheReadFactor` from Task 1.
- Produces (breaking change, internal to the package):

```ts
export function computeModelEnergyBreakdown(
  tokensByModel: ReadonlyMap<string, ModelTokens>,
  factors: Factors,
  cacheReadFactor = getCacheReadFactor(),
): ModelEnergyBreakdown[] // same shape { modelID, tokens, energyKwh }
export function computeSessionCo2(messages: readonly UsageMessage[], gridIntensity: number, factors: Factors): SessionCo2Summary
export function buildReportData(stats: SessionStats, gridIntensity: number, factors: Factors): ReportData
```

Removed exports: `PUE`, `ENERGY_PER_TOKEN_KWH`, `billableTokens`. Per model: `Wh = ((input + cacheWrite)·f.input + cacheRead·f.input·cacheReadFactor + (output + reasoning)·f.output) / 1e6`; `energyKwh = Wh / 1000`; `tokens` stays the raw sum (display only). `computeEquivalents` unchanged here.

- [ ] **Step 1: Update the energy tests first**

Rewrite the three energy tests (`weighted total across models`, `includes cache read/write tokens`, `empty map`) to the new signature and golden vectors. Golden vector (spec's agentic mix, sonnet family):

```ts
const tokens = { input: 21_000, output: 4_000, reasoning: 0, cacheRead: 975_000, cacheWrite: 0 }
const [entry] = computeModelEnergyBreakdown(new Map([["claude-sonnet-4-5", tokens]]), loadFactors())
const expectedWh = (21_000 * 136 + 975_000 * 136 * 0.08 + 4_000 * 2878) / 1e6 // 24.976
assert.ok(Math.abs(entry.energyKwh * 1000 - expectedWh) < 1e-9)
```

Also: tier fallback (`glm-5.3` bills at medium 136/2878), cache reads are ~12.5× cheaper than under the same tokens counted as input, `computeSessionCo2`/`buildReportData` updated signatures, and the harness/tool tests pass `loadFactors()` through.

- [ ] **Step 2: Run to verify they fail**

Run: `cd .opencode && npm test`
Expected: FAIL — signatures and values mismatch.

- [ ] **Step 3: Implement the new computation in `co2-core.ts` and thread `factors` through `co2-report.ts`, `co2-sidebar-logic.ts`, `index.ts`'s executor, and `tui.tsx`**

Per the Interfaces block. Update the module header comment to cite Jegham et al. 2025 and claude-carbon's methodology instead of Luccioni flat rates.

- [ ] **Step 4: Run to verify they pass**

Run: `cd .opencode && npm test && bun run test:bun && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode
git commit -m "feat!: bill energy per token kind with family factors"
```

### Task 3: Recalibrate eco grades

**Files:**
- Modify: `.opencode/plugins/co2-footprint/lib/co2-core.ts` (ECO_THRESHOLDS), `.opencode/co2-tracker.test.ts`

**Interfaces:** `getEcoGrade(co2Grams, messages)` signature unchanged; thresholds become exactly: A+ < 0.01, A < 0.03, B < 0.08, B- < 0.15, C < 0.3, D < 0.6, F ≥ 0.6 (g per message, ÷10 of the old scale per the spec).

- [ ] **Step 1: Update the boundary test first**

Same pattern as the existing `getEcoGrade: boundary values` test with the new thresholds (0.01 → A+, 0.010001 → A, 0.03 → A, 0.08 → B, 0.15 → B-, 0.3 → C, 0.6 → D, 0.600001 → F, 1e6 → F). Run: FAIL.

- [ ] **Step 2: Change ECO_THRESHOLDS** — Run: `cd .opencode && npm test`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .opencode
git commit -m "feat: recalibrate eco grades for the new energy model"
```

### Task 4: Repair real-world equivalents

**Files:**
- Modify: `lib/co2-core.ts` (`Equivalents`, `computeEquivalents`), `lib/co2-report.ts` (equivalents table rows), `.opencode/co2-tracker.test.ts`

**Interfaces:** `Equivalents` becomes `{ phoneCharges: number; ledBulbMinutes: number; kmDriven: number }`. `phoneCharges = grams / 8.7` (EPA 0.019 kWh × Ember 458 g/kWh), `kmDriven = grams / 200` (GFEI-derived world average), LED unchanged (energy-denominated). `googleSearches` and `videoStreamSeconds` are deleted (unsourced: 0.2 g/search is a 2009 blog figure; 36 g/h streaming unsourced — spec's decision, matching claude-carbon's own removal of searches).

- [ ] **Step 1: Update the equivalents tests first** — the LED test keeps its energy-invariance assertion but drops the `googleSearches` ratio line; add `phoneCharges`/`kmDriven` assertions at a fixed grams value. Run: FAIL.
- [ ] **Step 2: Implement** — Run: `cd .opencode && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add .opencode
git commit -m "fix: replace unsourced real-world equivalents with cited factors"
```

### Task 5: Version the lifetime storage key

**Files:**
- Modify: `.opencode/plugins/co2-footprint/tui.tsx`, `.opencode/co2-tracker.test.ts`

**Interfaces:** the TUI store key comes from `lifetimeStorageKey(loadFactors())` (Task 1) instead of the `"co2.lifetime.sessions"` literal.

- [ ] **Step 1: Wire the store key and pin the reset property**

`lifetimeStorageKey` is pure and already tested in Task 1, so there is no failing-test cycle here. Two edits: `tui.tsx` builds its store key with `lifetimeStorageKey(loadFactors())` instead of the `"co2.lifetime.sessions"` literal; and one test pins the reset property — `lifetimeStorageKey({ ...loadFactors(), version: 3 })` differs from `lifetimeStorageKey(loadFactors())`. Run the suite to confirm no regression.

- [ ] **Step 2: Typecheck + run** — `cd .opencode && npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add .opencode
git commit -m "feat: version the lifetime store key with the factors version"
```

### Task 6: METHODOLOGY.md + docs

**Files:**
- Create: `METHODOLOGY.md`
- Modify: `README.md` (methodology section + updated example figures), `CHANGELOG.md`

- [ ] **Step 1: Write `METHODOLOGY.md`**

Contents per the spec: the three-term formula; the factors table with per-family provenance (Jegham et al. v6 three-point fit → 136/2878 Wh/Mtok PUE-included at CIF 0.287; haiku 0.25× with the EcoLogits 0.07×–0.57× bounds; opus 2× with the honest 2×–5× band); `cache_read_factor` 0.08 default, published range 0.05–0.20, Irminsul citation and the 4k-vs-126k-context caveat; reasoning tokens at the output factor (HotCarbon 2026); grid intensity env var; the equivalents' sources (EPA, Ember, GFEI); limitations ("order of magnitude, not a carbon report": no embodied hardware, no training, grid-average, unmodelled context-length decode term); credit to claude-carbon's methodology (MIT); review date 2027-03.

- [ ] **Step 2: README + CHANGELOG**

README: methodology summary paragraph linking METHODOLOGY.md; example report output refreshed with numbers recomputed by the new formula (generate one with `/co2 export: "markdown"` during the smoke test — paste real output). CHANGELOG `[Unreleased]`: `### Changed` — energy is now billed per token kind from `factors.json` (headline CO2 drops ~75× on cache-heavy sessions, rises up to ~3× on output-heavy ones); grades rescaled ÷10; lifetime resets on factors-version bump; equivalents repaired. `### Removed` — flat per-tier energy rates, unsourced equivalents.

- [ ] **Step 3: Commit**

```bash
git add METHODOLOGY.md README.md CHANGELOG.md
git commit -m "docs: add a sourced METHODOLOGY.md for the new energy model"
```

**Phase 2 gate:** bloc of six commit messages → user "ok" → execute → push → smoke (`/co2` on a real session, before/after numbers quoted from this session's own history) → merge to fork `main`.

---

## Phase 3 — `feat/glm-kimi-factors`: GLM + Kimi overrides

### Task 1: Model overrides in `factors.json` + resolution

**Files:**
- Modify: `.opencode/plugins/co2-footprint/lib/factors.json`, `lib/co2-factors.ts`, `.opencode/co2-tracker.test.ts`

**Interfaces:**
- `Factors` gains `overrides: Record<string, string>` (model prefix → family name). Resolution order: **longest override key first** (match: id's last path segment equals the key or starts with it), then family markers, then tier. `resolveModelFactors` gains `"override"` as a possible `source`.
- `factors.json` gains:

```json
"overrides": {
  "glm-5.3": "sonnet",
  "glm-5.3-flash": "haiku",
  "kimi-k3.1-pro": "sonnet",
  "kimi-k3.1-pro-highspeed": "sonnet"
}
```

- [ ] **Step 1: Write the failing tests**

The prefix-collision test (Review Focus #1): `resolveModelFactors("glm-5.3-flash", loadFactors())` → haiku (NOT sonnet, despite `glm-5.3` being a prefix); `("glm-5.3")` → sonnet; `("glm-5.3-flash-20261121")` → haiku (longest key wins); `("opencode-go/glm-5.3")` → sonnet (last path segment); `("kimi-k3.1-pro-highspeed")` → sonnet; `("kimi-k3.1-pro")` → sonnet. `factors.version` stays 2 (adding models does not invalidate existing lifetime entries).

- [ ] **Step 2: Run to verify they fail**

Run: `cd .opencode && npm test`
Expected: FAIL — no overrides in resolution.

- [ ] **Step 3: Implement the override stage in `resolveModelFactors`** — Run: `cd .opencode && npm test && bun run test:bun && npm run typecheck`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .opencode
git commit -m "feat: add GLM and Kimi model factors"
```

### Task 2: Document the extrapolation

**Files:**
- Modify: `METHODOLOGY.md`, `CHANGELOG.md`

- [ ] **Step 1: METHODOLOGY gains a "Non-Anthropic models" section**

Jegham v6 covers 30 models (OpenAI, Anthropic, Meta, DeepSeek) — no GLM or Moonshot/Kimi measurement exists; `glm-5.3` and `kimi-k3.1-pro`/`-highspeed` are billed at sonnet-class factors (price list $2/$10 per MTok, identical to Sonnet, as the corroborating proxy — the same proxy claude-carbon uses for Fable), `glm-5.3-flash` at haiku-class (its `flash` marker already classified it small). Uncertainty: order-of-magnitude at best; revisit when an energy benchmark covers these families. CHANGELOG `[Unreleased]` `### Added`: GLM and Kimi model factors.

- [ ] **Step 2: Commit**

```bash
git add METHODOLOGY.md CHANGELOG.md
git commit -m "docs: document GLM and Kimi extrapolation uncertainty"
```

**Phase 3 gate:** bloc of two commit messages → user "ok" → execute → push → smoke (`/co2` shows `glm-5.3-flash` at haiku-class on this session's own history — the user's DB confirmed those are their real model ids) → merge to fork `main`.

---

## Final review

After Phase 3 merges, one fresh reviewer subagent reads the whole diff `main` vs upstream `main` against the spec and reports defects before the fork is declared done.
