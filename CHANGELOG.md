# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- OpenCode 2 (V2 plugin API) support: the `co2_report` tool registers through `ctx.tool.transform`, reads the session's full history via `ctx.session.context`, and accepts the V2 `SessionMessageInfo` shape (`type`, `model.id`); the sidebar is a V2 TUI part that persists its all-time total through the plugin storage.
- The plugin ships as a single package directory (`.opencode/plugins/co2-footprint/`) that OpenCode 2 auto-discovers, loading the server and TUI parts together.
- `METHODOLOGY.md`: the sourced chain behind every factor, with uncertainty bands and limits.
- An editable `lib/factors.json`: the whole CO2 model in one file. `OPENCODE_CO2_CACHE_READ_FACTOR` overrides the cache-read factor.
- GLM and Kimi model factors: `glm-5.3`, `glm-5.3-flash`, `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed` bill at sonnet/haiku-class factors through the `overrides` table in `factors.json` -- documented extrapolation, see METHODOLOGY.md.

### Changed

- Energy is billed per token kind (input and cache writes at the input factor, cache reads at 8% of it, output and reasoning at the ~21x output factor), per model family with tier fallback, PUE included in the factors. Headline CO2 drops ~75x on cache-heavy agentic sessions and rises up to ~3x on output-heavy ones; every displayed number changes.
- Eco grades rescaled: the thresholds are the previous scale divided by ten.
- The sidebar's all-time total is keyed by the factors version (`co2.lifetime.sessions.v2`): bump the version and it restarts cleanly instead of mixing formulas.
- The sidebar displays human-readable units (g / kg / t) picked by magnitude.
- The report footer and README example cite the current methodology; the example is a real report.
- The sidebar panel appends beside the built-in sidebar footer instead of replacing it (V2 slots compose; the host footer content stays visible).
- Minimum host version: OpenCode 2.0, tested with 2.3.1.
- The `/co2` report (`co2_report` tool) is computed from the session's full message history, read through the host session API, instead of from events seen by the running process. Resumed sessions and sessions started before an OpenCode restart are now reported in full, and the report always matches the sidebar.
- Report duration spans the session's first message to its last activity (it used to start at the first event the running process saw).
- Token counts in the report are always formatted with `en-US` digit grouping, independent of the host locale.
- Install flow: `INSTALL.md` installs from this repository and takes dependency versions from its `.opencode/package.json`. Its shell snippet reports errors without exiting the agent's shell.

### Removed

- OpenCode 1 support: the V1 `server()` entrypoint, the `tui.json` registration file, and the `@opencode-ai/plugin` dependency.
- Flat per-tier energy rates (Luccioni et al. 2023) and the unsourced real-world equivalents (Google searches, video streaming); the remaining equivalents are cited (EPA, Ember, GFEI).

### Fixed

- Model classification matches whole id segments: the `mini` inside `gemini` no longer classifies Gemini Pro models as small, and provider-prefixed ids (`openai/o3-mini`, `anthropic/claude-opus-4-5`) are classified like bare ids.
- Dated and suffixed OpenAI reasoning minis (`o3-mini-2025-01-31`, `o4-mini-high`) are classified medium like `o3-mini` and `o4-mini`, instead of small.
- The "Minutes of a 10W LED bulb" equivalent is computed from energy, so it is now correct when `OPENCODE_CO2_GRID_INTENSITY` is set (it assumed 400 gCO2/kWh).
- A failed session history request is reported as an error instead of an empty report.
- The README example output now matches what the report actually prints.
- The sidebar computes from the full paged message history instead of the data layer's trailing page, so a resumed long session no longer undercounts the session figure nor overwrites the all-time total with a truncated one (caught in final review).
- `loadFactors` rejects a factors file without a `families` table at load, instead of crashing later inside a computation.

## [0.2.0] - 2026-07-17

### Added

- TUI sidebar panel (`co2-sidebar.tsx`) showing session eco grade, CO2 and kWh, plus an all-time lifetime total persisted via `api.kv`.
- `export` argument on the `co2_report` tool: writes `co2-report.json` or `co2-report.md` to the project directory.
- `.opencode/tui.json` to register the sidebar plugin (TUI plugins are not auto-discovered).

## [0.1.0] - 2026-07-17

### Added

- `co2_report` tool and `/co2` command: eco report with session grade, per-model energy breakdown, CO2, real-world equivalents and tips.
- Per-model energy attribution with PUE, configurable grid intensity via `OPENCODE_CO2_GRID_INTENSITY`.

[Unreleased]: https://github.com/scaccogatto/opencode-footprint/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/scaccogatto/opencode-footprint/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/scaccogatto/opencode-footprint/releases/tag/v0.1.0
