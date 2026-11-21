# opencode-footprint

An [OpenCode](https://opencode.ai) plugin that tracks the CO2 carbon footprint of your coding sessions in real time. Get an eco report with a session grade, carbon footprint breakdown, real-world equivalents, and actionable tips to code greener.

## Features

- **Session tracking** -- the report is rebuilt from the session's active context on every call, so resumed sessions and OpenCode restarts are covered; the sidebar computes from the full paged history. See [METHODOLOGY.md](METHODOLOGY.md) for exactly what is counted.
- **Eco scoring** -- assigns a letter grade (A+ to F) based on CO2 efficiency per message
- **Real-world equivalents** -- translates grams of CO2 into smartphone charges, LED-bulb time and km driven, with every factor cited
- **Per-kind, per-model billing** -- cache reads at a reduced factor, output and reasoning at the decode factor, each model at its own family factors, summed across the session
- **Editable factors** -- every number lives in `factors.json`; bump its version and the all-time total restarts cleanly
- **Configurable grid intensity** -- override the default 400 gCO2/kWh with your region's carbon intensity
- **Sidebar panel** -- session grade/CO2/kWh and an all-time total, always visible in the OpenCode TUI (see [Sidebar](#sidebar))
- **Report export** -- write the eco report to `co2-report.json` or `co2-report.md` in the project directory
- **Zero config** -- drop the files into your project and it works

## Requirements

OpenCode **2.0 or later** (V2 plugin API), tested with **2.3.1**. The plugin SDK and `@opentui/*` versions to install are the ones pinned in [`.opencode/package.json`](.opencode/package.json) of the release you install.

## Install

The quickest way to install is to let OpenCode do it for you. Humans can fail, so let AI handle it. Paste this link into your OpenCode prompt:

```
https://raw.githubusercontent.com/scesbron/opencode-footprint/main/INSTALL.md
```

The agent downloads this repository, sets up dependencies, and verifies the installation.

### Manual install

If you prefer to do it yourself:

```sh
git clone --depth 1 https://github.com/scesbron/opencode-footprint.git

# Copy into your project
mkdir -p your-project/.opencode/plugins your-project/.opencode/commands
cp -r opencode-footprint/.opencode/plugins/co2-footprint your-project/.opencode/plugins/
cp -r opencode-footprint/.opencode/commands/co2.md your-project/.opencode/commands/
```

OpenCode 2 auto-discovers the plugin package directory and loads its server and TUI parts together -- no `tui.json`, no config line.

Then make sure the plugin SDK is installed: merge the `dependencies` block of this repository's `.opencode/package.json` into your project's `.opencode/package.json` (create it if missing). Only `dependencies` are needed, not the dev dependencies or scripts.

OpenCode runs `bun install` automatically at startup, so dependencies will be resolved on the next launch.

## Usage

There are two ways to see your eco report:

### Slash command

Type `/co2` in the OpenCode TUI to generate your session's eco report.

### Natural language

Ask OpenCode about your session's carbon footprint, CO2 emissions, or environmental impact. The agent will call the `co2_report` tool automatically.

### Exporting the report

Ask OpenCode to export the report (or call the tool with `export: "json"` / `export: "markdown"`) to write it to the project directory:

- `export: "json"` -- writes `co2-report.json` (raw numbers, no formatting -- grade, tokens, energy, CO2, per-model breakdown, providers)
- `export: "markdown"` -- writes `co2-report.md` (the same report shown in the TUI)

The tool's text output always includes the eco report, plus the exported file's path when `export` is passed.

### Example output

```
## Eco Report | Your Coding Carbon Footprint

> **Session Grade: F** -- Very High Impact
> Impact: `[██████████]`

---

### Session Overview

| Metric | Value |
|---|---|
| Duration | 108.8 min |
| Messages | 149 |
| Total tokens | 38,070,633 |
| API cost | $0.000000 |

### Per-Model Breakdown

| Model | Tokens | Energy |
|---|---|---|
| glm-5.3 | 38,070,633 | 1049.2592 Wh |

### Carbon Footprint

| Metric | Value |
|---|---|
| Energy consumed | 1049.2592 Wh |
| **CO2 emitted** | **419.7037 g** |
| CO2 per message | 2.8168 g |
| Grid intensity | 400 gCO2/kWh |

### Real-World Equivalents

Your session's footprint is roughly equal to:

| Equivalent | Amount |
|---|---|
| Smartphone charges | ~48.242 |
| Minutes of a 10W LED bulb | ~6295.6 |
| km driven (world avg car) | ~2.09852 |

### Token Breakdown

| Type | Count |
|---|---|
| Input | 378,287 |
| Output | 64,303 |
| Reasoning | 140,683 |
| Cache read | 37,487,360 |
| Cache write | 0 |

### Providers

- opencode-go

---

> **Tip:** Consider breaking work into smaller sessions and using efficient models.

*Estimates follow the claude-carbon methodology, fitted on Jegham et al. (2025) -- see METHODOLOGY.md for sources and limits. Configure grid intensity with `OPENCODE_CO2_GRID_INTENSITY` and the cache-read factor with `OPENCODE_CO2_CACHE_READ_FACTOR`.*
```

A real report, from this plugin's own development session: 149 messages on one model, 98.5% of the tokens hitting the cache. The per-kind formula is what keeps a 38M-token session near 1 kWh -- the previous flat rate would have billed it around 42 kWh.

## Configuration

### Grid carbon intensity

The default grid intensity is **400 gCO2/kWh** (IEA global average). Override it with an environment variable to match your region:

```sh
# Example: France (~50 gCO2/kWh, mostly nuclear)
export OPENCODE_CO2_GRID_INTENSITY=50

# Example: Poland (~700 gCO2/kWh, coal-heavy)
export OPENCODE_CO2_GRID_INTENSITY=700
```

You can find your country's grid intensity at [Electricity Maps](https://app.electricitymaps.com).

## How it works

### Energy estimation

Each model resolves to an energy family (sonnet, haiku, opus -- matched as whole id segments) or falls back to a size tier, and each token kind bills at its own factor, in Wh per million tokens with PUE included:

| Family / tier | Input (Wh/Mtok) | Output (Wh/Mtok) |
|---|---|---|
| sonnet (tier: medium) | 136 | 2878 |
| haiku (tier: small) | 35 | 722 |
| opus (tier: large) | 272 | 5756 |

Cache writes count at the input factor (a full prefill), cache reads at 8% of it (override with `OPENCODE_CO2_CACHE_READ_FACTOR`), and output and reasoning tokens at the output factor, ~21x the input factor: decoding is memory-bandwidth-bound and dominates a session's energy. Every number lives in the editable `lib/factors.json` -- bump its `version` when you change a factor, and the sidebar's all-time total restarts cleanly instead of mixing formulas. Sources, uncertainty bands and limits: [METHODOLOGY.md](METHODOLOGY.md).

### CO2 calculation

```
per_model_energy (Wh) = (input + cache_write) * f_in
                     + cache_read * f_in * cache_read_factor
                     + (output + reasoning) * f_out
energy (kWh)          = sum(per_model_energy) / 1000
CO2 (grams)           = energy (kWh) * grid_intensity (gCO2/kWh)
```

The factors carry the data-center overhead (PUE included); the grid intensity defaults to the IEA global average, overridable per region.

### Eco grade

The session grade is based on grams of CO2 per message, on the scale of the per-kind energy model (the thresholds are the previous scale divided by ten, locked by the golden vectors):

| Grade | CO2/message | Label |
|-------|------------|-------|
| A+    | < 0.01g    | Exemplary |
| A     | < 0.03g    | Excellent |
| B     | < 0.08g    | Good |
| B-    | < 0.15g    | Above Average |
| C     | < 0.3g     | Moderate |
| D     | < 0.6g     | High Impact |
| F     | >= 0.6g    | Very High Impact |

### References

- Jegham et al. "How Hungry is AI? Benchmarking Energy, Water, and Carbon Footprint of LLM Inference" (2025, arXiv:2505.09598) -- sonnet-family factors, three-point fit
- [claude-carbon](https://github.com/gwittebolle/claude-carbon) (MIT, gwittebolle) -- the methodology this plugin follows; see [METHODOLOGY.md](METHODOLOGY.md) for the full chain of sources
- Irminsul (arXiv:2605.05696) -- cache-read factor measurement
- Pasandi & Nadeem (HotCarbon 2026) -- reasoning tokens at the output factor
- IEA global average grid carbon intensity

## Sidebar

A TUI part (`.opencode/plugins/co2-footprint/tui.tsx`) renders the current session's eco grade and an all-time total, appended beside the sidebar footer's built-in content:

```
B  1.18 g CO2  0.0118 kWh
lifetime: 42.5 g
```

- Line 1: session eco grade, CO2 grams, and energy (kWh) for the open session -- recomputed reactively as messages stream in, from the full paged history overlaid with the live page, using the same `lib/co2-core.ts` math as the `/co2` report. After a compaction the report (active context) and the sidebar (full history) can legitimately differ: see [METHODOLOGY.md](METHODOLOGY.md).
- Line 2: `lifetime: X g` -- an all-time CO2 total accumulated across every session, persisted through the TUI plugin storage so it survives restarts.

OpenCode 2 slots compose: the panel appends to the sidebar footer and the built-in footer content (path, version) stays visible. The panel is blank until the session's first assistant reply.

## Project structure

```
.opencode/
  plugins/
    co2-footprint/
      package.json       # Plugin package: exports "." (server) and "./tui" (sidebar)
      index.ts           # V2 server plugin: co2_report tool
      tui.tsx            # V2 TUI plugin: sidebar_footer panel
      lib/
        co2-core.ts          # Pure CO2 model: classification, energy, grade, equivalents, lifetime totals
        co2-report.ts        # Pure report builder (markdown + JSON) over a session's message history
        co2-sidebar-logic.ts # Pure sidebar logic (session summary, formatting)
  commands/
    co2.md               # Slash command definition for /co2
  co2-tracker.test.ts     # Unit tests (node --test and bun test)
  bun.lock                # Dev lockfile (CI installs with --frozen-lockfile)
  package.json            # Plugin SDK + @opentui/solid-js dependencies, typecheck/test scripts
  tsconfig.json           # Typecheck config (incl. Solid JSX for the sidebar)
.github/
  workflows/
    ci.yml                # Typecheck + tests on Node 24 and Bun
```

The plugin ships as one package directory: OpenCode 2 auto-discovers it, loading the server part and the TUI part together. The pure modules live under `lib/` to keep them unit-testable and free of host-API imports.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) -- Marco Boffo
