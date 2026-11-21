import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import co2FootprintPlugin from "./plugins/co2-footprint/index.ts"
import {
  aggregateTokensByModel,
  computeEquivalents,
  computeModelEnergyBreakdown,
  getEcoGrade,
  getGridIntensity,
  sumEnergyKwh,
  summarizeLifetime,
  upsertLifetimeSession,
  type LifetimeSessions,
  type ModelTokens,
  type UsageMessage,
} from "./plugins/co2-footprint/lib/co2-core.ts"
import { buildReportData, buildSessionStats, formatReport } from "./plugins/co2-footprint/lib/co2-report.ts"
import { computeSessionCo2, formatLifetimeLine, formatMass, formatSessionLine } from "./plugins/co2-footprint/lib/co2-sidebar-logic.ts"
import {
  classifyModel,
  getCacheReadFactor,
  lifetimeStorageKey,
  loadFactors,
  resolveModelFactors,
} from "./plugins/co2-footprint/lib/co2-factors.ts"

// ---------------------------------------------------------------------------
// classifyModel
// ---------------------------------------------------------------------------

test("classifyModel: exact matches", () => {
  assert.equal(classifyModel("claude-haiku-4-5"), "small")
  assert.equal(classifyModel("claude-sonnet-4-5"), "medium")
  assert.equal(classifyModel("claude-opus-4"), "large")
})

test("classifyModel: fuzzy substring matches", () => {
  assert.equal(classifyModel("some-mini-model"), "small")
  assert.equal(classifyModel("some-nano-variant"), "small")
  assert.equal(classifyModel("gemini-flash-experimental"), "small")
  assert.equal(classifyModel("weird-opus-clone"), "large")
  assert.equal(classifyModel("acme-o3-preview"), "large")
  // Fuzzy "mini" substring wins over the fuzzy "o3" check, for models not
  // already covered by an exact MODEL_SIZE entry.
  assert.equal(classifyModel("acme-o3-mini-preview"), "small")
})

test("classifyModel: 'mini' inside 'gemini' is not a small-model marker", () => {
  assert.equal(classifyModel("gemini-3-pro-preview"), "medium")
  assert.equal(classifyModel("gemini-2.5-pro-preview-06-05"), "medium")
  assert.equal(classifyModel("google/gemini-2.5-pro"), "medium")
  assert.equal(classifyModel("gemini-2.5-flash-lite"), "small")
  assert.equal(classifyModel("gemini-3-flash-preview"), "small")
})

test("classifyModel: current Claude and GPT-5 ids, bare or provider-prefixed", () => {
  assert.equal(classifyModel("claude-opus-4-5"), "large")
  assert.equal(classifyModel("claude-opus-4-1-20250805"), "large")
  assert.equal(classifyModel("anthropic/claude-sonnet-4-5"), "medium")
  assert.equal(classifyModel("claude-haiku-4-5-20251001"), "small")
  assert.equal(classifyModel("anthropic.claude-opus-4-5-20251101-v1:0"), "large")
  assert.equal(classifyModel("gpt-5"), "medium")
  assert.equal(classifyModel("openai/gpt-5-mini"), "small")
  assert.equal(classifyModel("gpt-5-nano"), "small")
  assert.equal(classifyModel("openai/o3-mini"), "medium")
  assert.equal(classifyModel("Claude-Opus-4"), "large")
})

test("classifyModel: markers match whole segments, not substrings", () => {
  assert.equal(classifyModel("minimax-m2"), "medium")
  assert.equal(classifyModel("pro3-model"), "medium")
})

test("classifyModel: exact MODEL_SIZE entries win over fuzzy matching", () => {
  // "o3-mini" is an exact MODEL_SIZE entry (medium), even though it also
  // contains the fuzzy "mini" substring that would otherwise mean small.
  assert.equal(classifyModel("o3-mini"), "medium")
})

test("classifyModel: exception entries also match suffixed variants", () => {
  assert.equal(classifyModel("o3-mini-2025-01-31"), "medium")
  assert.equal(classifyModel("o4-mini-high"), "medium")
  assert.equal(classifyModel("openai/o4-mini-2025-04-16"), "medium")
})

test("classifyModel: unknown model defaults to medium", () => {
  assert.equal(classifyModel("totally-unknown-model-xyz"), "medium")
})

// ---------------------------------------------------------------------------
// getEcoGrade boundaries
// ---------------------------------------------------------------------------

test("getEcoGrade: boundary values map to the correct grade", () => {
  assert.equal(getEcoGrade(0.01, 1).grade, "A+")
  assert.equal(getEcoGrade(0.010001, 1).grade, "A")
  assert.equal(getEcoGrade(0.03, 1).grade, "A")
  assert.equal(getEcoGrade(0.08, 1).grade, "B")
  assert.equal(getEcoGrade(0.15, 1).grade, "B-")
  assert.equal(getEcoGrade(0.3, 1).grade, "C")
  assert.equal(getEcoGrade(0.6, 1).grade, "D")
  assert.equal(getEcoGrade(0.600001, 1).grade, "F")
  assert.equal(getEcoGrade(1_000_000, 1).grade, "F")
})

test("getEcoGrade: zero messages does not divide by zero", () => {
  const grade = getEcoGrade(5, 0)
  assert.equal(grade.grade, "A+") // perMsg falls back to 0
})

// ---------------------------------------------------------------------------
// Per-model energy: billed per token kind, family factors, PUE included
// ---------------------------------------------------------------------------

test("computeModelEnergyBreakdown + sumEnergyKwh: per-kind billing across models", () => {
  const tokensByModel = new Map<string, ModelTokens>([
    ["claude-haiku-4-5", { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
    ["claude-opus-4", { input: 0, output: 2000, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
  ])

  const breakdown = computeModelEnergyBreakdown(tokensByModel, loadFactors())
  assert.equal(breakdown.length, 2)

  const haiku = breakdown.find((b) => b.modelID === "claude-haiku-4-5")!
  const opus = breakdown.find((b) => b.modelID === "claude-opus-4")!
  assert.equal(haiku.tokens, 1000)
  assert.equal(opus.tokens, 2000)

  // 1k haiku input at 35 Wh/Mtok = 0.035 Wh; 2k opus output at 5756 Wh/Mtok = 11.512 Wh.
  assert.ok(Math.abs(haiku.energyKwh * 1000 - 0.035) < 1e-9)
  assert.ok(Math.abs(opus.energyKwh * 1000 - 11.512) < 1e-9)

  const total = sumEnergyKwh(breakdown)
  assert.ok(Math.abs(total - (haiku.energyKwh + opus.energyKwh)) < 1e-12)
})

test("computeModelEnergyBreakdown: golden vector for the agentic mix (sonnet)", () => {
  const tokens: ModelTokens = { input: 21_000, output: 4_000, reasoning: 0, cacheRead: 975_000, cacheWrite: 0 }
  const [entry] = computeModelEnergyBreakdown(new Map([["claude-sonnet-4-5", tokens]]), loadFactors())
  const expectedWh = (21_000 * 136 + 975_000 * 136 * 0.08 + 4_000 * 2878) / 1e6
  assert.ok(Math.abs(entry.energyKwh * 1000 - expectedWh) < 1e-9)
  assert.equal(entry.tokens, 1_000_000)
})

test("computeModelEnergyBreakdown: cache reads bill at the reduced factor; tier fallback for unknown models", () => {
  const cached: ModelTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 }
  const [entry] = computeModelEnergyBreakdown(new Map([["glm-5.3", cached]]), loadFactors())
  // 1M cache reads at sonnet-class 136 Wh/Mtok * 0.08 = 10.88 Wh.
  assert.ok(Math.abs(entry.energyKwh * 1000 - 136 * 0.08) < 1e-9)
})

test("computeModelEnergyBreakdown: reasoning tokens bill at the output factor", () => {
  const tokens: ModelTokens = { input: 0, output: 0, reasoning: 1000, cacheRead: 0, cacheWrite: 0 }
  const [entry] = computeModelEnergyBreakdown(new Map([["claude-sonnet-4-5", tokens]]), loadFactors())
  assert.ok(Math.abs(entry.energyKwh * 1000 - (1000 * 2878) / 1e6) < 1e-12)
})

test("computeModelEnergyBreakdown: cacheReadFactor override moves only the cache term", () => {
  const tokens: ModelTokens = { input: 100_000, output: 100_000, reasoning: 0, cacheRead: 100_000, cacheWrite: 0 }
  const [atDefault] = computeModelEnergyBreakdown(new Map([["claude-sonnet-4-5", tokens]]), loadFactors())
  const [atTiny] = computeModelEnergyBreakdown(new Map([["claude-sonnet-4-5", tokens]]), loadFactors(), 0.0001)
  const moved = atDefault.energyKwh * 1000 - atTiny.energyKwh * 1000
  assert.ok(Math.abs(moved - (100_000 * 136 * (0.08 - 0.0001)) / 1e6) < 1e-9)
})

test("computeModelEnergyBreakdown: empty map yields zero energy, no NaN", () => {
  const breakdown = computeModelEnergyBreakdown(new Map(), loadFactors())
  assert.equal(breakdown.length, 0)
  const total = sumEnergyKwh(breakdown)
  assert.equal(total, 0)
  assert.ok(!Number.isNaN(total))
})

// ---------------------------------------------------------------------------
// Lifetime totals reducer (upsertLifetimeSession / summarizeLifetime)
// ---------------------------------------------------------------------------

test("upsertLifetimeSession: adds a new session entry", () => {
  const sessions = upsertLifetimeSession({}, "s1", { grams: 5, kwh: 0.01 })
  assert.deepEqual(sessions, { s1: { grams: 5, kwh: 0.01 } })
})

test("upsertLifetimeSession: overwrites (not adds to) an existing session's entry", () => {
  const sessions: LifetimeSessions = { s1: { grams: 5, kwh: 0.01 } }
  const updated = upsertLifetimeSession(sessions, "s1", { grams: 9, kwh: 0.02 })
  assert.deepEqual(updated, { s1: { grams: 9, kwh: 0.02 } })
  // Original object is untouched (pure function).
  assert.deepEqual(sessions, { s1: { grams: 5, kwh: 0.01 } })
})

test("upsertLifetimeSession: repeated upserts of the same running total are idempotent", () => {
  let sessions: LifetimeSessions = {}
  sessions = upsertLifetimeSession(sessions, "s1", { grams: 3, kwh: 0.001 })
  sessions = upsertLifetimeSession(sessions, "s1", { grams: 3, kwh: 0.001 })
  sessions = upsertLifetimeSession(sessions, "s1", { grams: 3, kwh: 0.001 })
  assert.deepEqual(summarizeLifetime(sessions), { grams: 3, kwh: 0.001, sessions: 1 })
})

test("summarizeLifetime: sums grams/kwh across sessions and counts them", () => {
  const sessions: LifetimeSessions = {
    s1: { grams: 5, kwh: 0.01 },
    s2: { grams: 2.5, kwh: 0.005 },
  }
  assert.deepEqual(summarizeLifetime(sessions), { grams: 7.5, kwh: 0.015, sessions: 2 })
})

test("summarizeLifetime: empty map yields all-zero summary, no NaN", () => {
  const summary = summarizeLifetime({})
  assert.deepEqual(summary, { grams: 0, kwh: 0, sessions: 0 })
})

// ---------------------------------------------------------------------------
// Sidebar logic: aggregateTokensByModel / computeSessionCo2 / formatting
// ---------------------------------------------------------------------------

test("aggregateTokensByModel: sums tokens per model across assistant messages, ignores others", () => {
  const messages = [
    { role: "user", modelID: "claude-sonnet-4-5", tokens: { input: 999 } },
    {
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
    },
    {
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 200, output: 25 },
    },
    {
      role: "assistant",
      modelID: "claude-haiku-4-5",
      tokens: { input: 1000 },
    },
  ]

  const byModel = aggregateTokensByModel(messages)
  assert.equal(byModel.size, 2)
  assert.deepEqual(byModel.get("claude-sonnet-4-5"), {
    input: 300,
    output: 75,
    reasoning: 0,
    cacheRead: 10,
    cacheWrite: 5,
  })
  assert.deepEqual(byModel.get("claude-haiku-4-5"), {
    input: 1000,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

test("aggregateTokensByModel: missing/malformed token fields default to 0, no NaN", () => {
  const messages = [
    { role: "assistant", modelID: "unknown-model" },
    { role: "assistant", tokens: { input: "not-a-number" } },
  ]
  const byModel = aggregateTokensByModel(messages)
  for (const tokens of byModel.values()) {
    for (const value of Object.values(tokens)) {
      assert.ok(!Number.isNaN(value))
    }
  }
})

test("computeSessionCo2: derives grade/energy/co2 for a session's messages", () => {
  const messages = [
    { role: "assistant", modelID: "claude-opus-4", tokens: { input: 2000, output: 1000 } },
  ]
  const summary = computeSessionCo2(messages, 400, loadFactors())
  assert.equal(summary.messages, 1)
  // opus family: 2000 input at 272 Wh/Mtok + 1000 output at 5756 Wh/Mtok.
  const expectedWh = (2000 * 272 + 1000 * 5756) / 1e6
  assert.ok(Math.abs(summary.energyKwh * 1000 - expectedWh) < 1e-9)
  assert.ok(Math.abs(summary.co2Grams - summary.energyKwh * 400) < 1e-9)
  assert.equal(summary.grade, getEcoGrade(summary.co2Grams, 1).grade)
})

test("computeSessionCo2: no assistant messages yields zero footprint, no NaN", () => {
  const summary = computeSessionCo2([], 400, loadFactors())
  assert.deepEqual(summary, { grade: "A+", co2Grams: 0, energyKwh: 0, messages: 0 })
})

test("formatMass: picks the unit that matches the magnitude", () => {
  assert.equal(formatMass(0), "0.00 g")
  assert.equal(formatMass(0.42), "0.42 g")
  assert.equal(formatMass(9.99), "9.99 g")
  assert.equal(formatMass(42.5), "42.5 g")
  assert.equal(formatMass(123), "123 g")
  assert.equal(formatMass(1234), "1.23 kg")
  assert.equal(formatMass(11045.86), "11.05 kg")
  assert.equal(formatMass(1_250_000), "1.25 t")
})

test("formatSessionLine / formatLifetimeLine: render the expected one-line strings", () => {
  const line = formatSessionLine({ grade: "B", co2Grams: 1.234, energyKwh: 0.05678, messages: 3 })
  assert.equal(line, "B  1.23 g CO2  0.0568 kWh")

  const lifetime = formatLifetimeLine({ grams: 42.5, kwh: 1.2, sessions: 7 })
  assert.equal(lifetime, "lifetime: 42.5 g")
})

// ---------------------------------------------------------------------------
// Grid intensity and real-world equivalents
// ---------------------------------------------------------------------------

test("getGridIntensity: env override, rejects invalid values", () => {
  assert.equal(getGridIntensity({}), 400)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "50" }), 50)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "-3" }), 400)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "abc" }), 400)
  assert.equal(getGridIntensity({ OPENCODE_CO2_GRID_INTENSITY: "Infinity" }), 400)
})

test("computeEquivalents: LED minutes depend on energy; phone charges and km on CO2", () => {
  const energyKwh = 0.01 // 10 Wh = one hour of a 10W bulb
  const at400 = computeEquivalents(energyKwh * 400, energyKwh)
  const at50 = computeEquivalents(energyKwh * 50, energyKwh)
  assert.ok(Math.abs(at400.ledBulbMinutes - 60) < 1e-9)
  assert.ok(Math.abs(at50.ledBulbMinutes - 60) < 1e-9)
  // CO2-denominated equivalents do scale with the grid.
  assert.ok(Math.abs(at400.phoneCharges / at50.phoneCharges - 8) < 1e-9)
  assert.ok(Math.abs(at400.kmDriven / at50.kmDriven - 8) < 1e-9)
})

test("computeEquivalents: cited factors (EPA charge, GFEI world car), unsourced rows removed", () => {
  const eq = computeEquivalents(8.7, 0.01)
  assert.ok(Math.abs(eq.phoneCharges - 1) < 1e-9)
  assert.ok(Math.abs(eq.kmDriven - 8.7 / 200) < 1e-9)
  assert.ok(!("googleSearches" in eq))
  assert.ok(!("videoStreamSeconds" in eq))
})

// ---------------------------------------------------------------------------
// Report building from the session's message history
// ---------------------------------------------------------------------------

const history: UsageMessage[] = [
  { role: "user", time: { created: 1_000_000 } },
  {
    role: "assistant",
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    cost: 0.02,
    tokens: { input: 8000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_010_000, completed: 1_060_000 },
  },
  { role: "user", time: { created: 1_100_000 } },
  {
    role: "assistant",
    modelID: "claude-haiku-4-5",
    providerID: "anthropic",
    cost: 0.004,
    tokens: { input: 2000, output: 450, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_110_000, completed: 1_120_000 },
  },
  {
    role: "assistant",
    modelID: "gpt-5",
    providerID: "openai",
    cost: 0.01,
    tokens: { input: 1000, output: 500, reasoning: 500, cache: { read: 1000, write: 0 } },
    time: { created: 1_130_000 },
  },
]

test("buildSessionStats: per-model tokens, cost, providers and duration from history", () => {
  const stats = buildSessionStats(history)
  assert.equal(stats.messages, 3)
  assert.ok(Math.abs(stats.costUsd - 0.034) < 1e-12)
  assert.deepEqual(stats.providers, ["anthropic", "openai"])
  // First message created (1_000_000) to last activity (1_130_000).
  assert.ok(Math.abs(stats.durationMinutes - 130_000 / 60_000) < 1e-12)
  assert.deepEqual(stats.tokensByModel.get("gpt-5"), {
    input: 1000,
    output: 500,
    reasoning: 500,
    cacheRead: 1000,
    cacheWrite: 0,
  })
})

test("buildSessionStats: empty or malformed history yields zeros, no NaN", () => {
  const stats = buildSessionStats([null, undefined, { role: "assistant", cost: "x", time: { created: "y" } }])
  assert.equal(stats.messages, 1)
  assert.equal(stats.costUsd, 0)
  assert.equal(stats.durationMinutes, 0)
  assert.deepEqual(stats.providers, [])
})

test("buildReportData + formatReport: consistent numbers across JSON and markdown", () => {
  const data = buildReportData(buildSessionStats(history), 400, loadFactors())
  assert.equal(data.totalTokens, 15450)
  assert.deepEqual(data.tokensByType, { input: 11000, output: 2950, reasoning: 500, cacheRead: 1000, cacheWrite: 0 })
  const report = formatReport(data)
  assert.ok(report.includes(`**Session Grade: ${data.grade}**`))
  assert.ok(report.includes("| Total tokens | 15,450 |"))
  assert.ok(report.includes("| API cost | $0.034000 |"))
  assert.ok(report.includes(`| **CO2 emitted** | **${data.co2Grams.toFixed(4)} g** |`))
  assert.ok(report.includes("Your session's footprint is roughly equal to:"))
  assert.ok(report.includes("### Token Breakdown"))
  assert.ok(report.includes("- anthropic\n- openai"))
})

// The V2 host's SessionMessageInfo: `type` (not `role`), `model: { id, providerID }`
// (not `modelID`), tokens and cost at the top level. Captured from a live
// session.context response; the V1-shaped `history` fixture above pins the
// structural view's tolerance for the older flat shape.
const hostHistory: UsageMessage[] = [
  { type: "user", time: { created: 1_000_000 } },
  {
    type: "assistant",
    model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
    cost: 0.02,
    tokens: { input: 8000, output: 2000, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_010_000, completed: 1_060_000 },
  },
  { type: "user", time: { created: 1_100_000 } },
  {
    type: "assistant",
    model: { id: "claude-haiku-4-5", providerID: "anthropic" },
    cost: 0.004,
    tokens: { input: 2000, output: 450, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_110_000, completed: 1_120_000 },
  },
  {
    type: "assistant",
    model: { id: "gpt-5", providerID: "openai" },
    cost: 0.01,
    tokens: { input: 1000, output: 500, reasoning: 500, cache: { read: 1000, write: 0 } },
    time: { created: 1_130_000 },
  },
]

test("aggregateTokensByModel: accepts the V2 host shape (type, model.id)", () => {
  const messages: UsageMessage[] = [
    { type: "user", time: { created: 1 } },
    {
      type: "assistant",
      model: { id: "glm-5.3", providerID: "opencode-go" },
      tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 500, write: 10 } },
      cost: 0.02,
    },
  ]
  const byModel = aggregateTokensByModel(messages)
  assert.equal(byModel.size, 1)
  assert.deepEqual(byModel.get("glm-5.3"), {
    input: 1000,
    output: 200,
    reasoning: 50,
    cacheRead: 500,
    cacheWrite: 10,
  })
})

test("buildSessionStats: reads provider and cost from the V2 host shape", () => {
  const stats = buildSessionStats([
    {
      type: "assistant",
      model: { id: "glm-5.3", providerID: "opencode-go" },
      tokens: { input: 10 },
      cost: 0.01,
    },
  ])
  assert.equal(stats.messages, 1)
  assert.deepEqual(stats.providers, ["opencode-go"])
  assert.ok(Math.abs(stats.costUsd - 0.01) < 1e-12)
})

// ---------------------------------------------------------------------------
// co2_report tool (V2 plugin): registered through ctx.tool.transform, reads
// the session's full history via ctx.session.context
// ---------------------------------------------------------------------------

type AddedTool = {
  name: string
  description: string
  execute: (args: { export?: "json" | "markdown" }, context: { sessionID: string }) => Promise<unknown>
}

async function loadTool(history: () => Promise<unknown[]>, directory = "/unused") {
  const added: AddedTool[] = []
  const requested: string[] = []
  const ctx = {
    location: { directory },
    tool: {
      transform: async (callback: (editor: unknown) => void) =>
        void callback({ add: (tool: AddedTool) => void added.push(tool) }),
    },
    session: {
      context: async ({ sessionID }: { sessionID: string }) => {
        requested.push(sessionID)
        return history()
      },
    },
  }
  const plugin = co2FootprintPlugin as { id: string; setup: (ctx: unknown) => Promise<void> }
  await plugin.setup(ctx)
  assert.equal(plugin.id, "opencode-footprint.co2-tracker")
  assert.equal(added.length, 1)
  assert.equal(added[0].name, "co2_report")
  assert.ok(added[0].description.length > 0)
  return { tool: added[0], requested }
}

async function run(tool: AddedTool, args: { export?: "json" | "markdown" }, sessionID = "s1") {
  const result = (await tool.execute(args, { sessionID })) as { content: string }
  return result.content
}

test("co2_report tool: reports a resumed session's full history without any live events", async () => {
  const { tool, requested } = await loadTool(() => Promise.resolve(hostHistory))
  const output = await run(tool, {}, "s-resumed")
  assert.deepEqual(requested, ["s-resumed"])
  assert.ok(output.includes("| Messages | 3 |"))
  assert.ok(output.includes("| Total tokens | 15,450 |"))
  assert.ok(output.includes("| API cost | $0.034000 |"))
  assert.ok(output.includes("| claude-haiku-4-5 | 2,450 |"))
  assert.ok(output.includes("| gpt-5 | 3,000 |"))
})

test("co2_report tool: re-reads history on every call (streamed updates are never double-counted)", async () => {
  const snapshots: UsageMessage[][] = [
    [{ type: "assistant", model: { id: "claude-sonnet-4-5" }, tokens: { input: 100 }, cost: 0.001 }],
    [{ type: "assistant", model: { id: "claude-sonnet-4-5" }, tokens: { input: 100, output: 50 }, cost: 0.002 }],
    [{ type: "assistant", model: { id: "claude-sonnet-4-5" }, tokens: { input: 100, output: 400 }, cost: 0.005 }],
  ]
  let call = 0
  const { tool } = await loadTool(() => Promise.resolve(snapshots[call++].map((info) => ({ info }))))
  await run(tool, {})
  await run(tool, {})
  const output = await run(tool, {})
  assert.ok(output.includes("| Messages | 1 |"))
  assert.ok(output.includes("| Total tokens | 500 |"))
  assert.ok(output.includes("| API cost | $0.005000 |"))
})

test("co2_report tool: no assistant messages yet", async () => {
  const { tool } = await loadTool(() => Promise.resolve([{ type: "user" }]))
  const output = await run(tool, {})
  assert.ok(output.startsWith("No usage data recorded yet"))
})

test("co2_report tool: surfaces a failed history request instead of an empty report", async () => {
  const { tool } = await loadTool(() => Promise.reject(new Error("NotFoundError")))
  const output = await run(tool, {}, "missing")
  assert.ok(output.startsWith("Could not read this session's messages"))
  assert.ok(output.includes("NotFoundError"))
})

test("co2_report tool: export writes co2-report.json and co2-report.md, both readable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "co2-export-"))
  try {
    const { tool } = await loadTool(
      () =>
        Promise.resolve([
          {
            info: {
              type: "assistant",
              model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
              tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0.01,
            },
          },
        ]),
      dir,
    )

    const jsonOutput = await run(tool, { export: "json" })
    const jsonPath = path.join(dir, "co2-report.json")
    assert.ok(jsonOutput.includes(jsonPath))
    const parsed = JSON.parse(await readFile(jsonPath, "utf8"))
    assert.equal(parsed.messages, 1)
    assert.equal(parsed.totalTokens, 1500)
    assert.equal(parsed.costUsd, 0.01)
    assert.ok(parsed.co2Grams > 0)

    const mdOutput = await run(tool, { export: "markdown" })
    const mdPath = path.join(dir, "co2-report.md")
    assert.ok(mdOutput.includes(mdPath))
    const mdContent = await readFile(mdPath, "utf8")
    assert.ok(mdContent.includes("Eco Report"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the plugin package exposes server and tui parts, with no stray top-level plugin files", async () => {
  const pluginsDir = path.join(import.meta.dirname, "plugins")
  const entries = (await readdir(pluginsDir, { withFileTypes: true })).map((entry) => entry.name).sort()
  assert.deepEqual(entries, ["co2-footprint"])
  const pkg = JSON.parse(await readFile(path.join(pluginsDir, "co2-footprint", "package.json"), "utf8"))
  assert.deepEqual(pkg.exports, { ".": "./index.ts", "./tui": "./tui.tsx" })
})

// ---------------------------------------------------------------------------
// factors.json + co2-factors: the editable energy factor table
// ---------------------------------------------------------------------------

test("loadFactors: returns the shipped factor table", () => {
  const factors = loadFactors()
  assert.equal(factors.version, 2)
  assert.equal(factors.cacheReadFactor, 0.08)
  assert.deepEqual(factors.families.sonnet, { input: 136, output: 2878 })
  assert.deepEqual(factors.families.haiku, { input: 35, output: 722 })
  assert.deepEqual(factors.families.opus, { input: 272, output: 5756 })
  assert.deepEqual(factors.tiers, {
    small: { input: 35, output: 722 },
    medium: { input: 136, output: 2878 },
    large: { input: 272, output: 5756 },
  })
})

test("resolveModelFactors: known families, tier fallback for the rest", () => {
  const factors = loadFactors()
  const sonnet = resolveModelFactors("claude-sonnet-4-5", factors)
  assert.equal(sonnet.source, "family")
  assert.equal(sonnet.label, "sonnet")
  assert.equal(sonnet.input, 136)
  assert.equal(sonnet.output, 2878)

  const opus = resolveModelFactors("anthropic/claude-opus-4-5-20251101", factors)
  assert.equal(opus.source, "family")
  assert.equal(opus.label, "opus")

  const glm = resolveModelFactors("glm-5.3", factors)
  assert.equal(glm.source, "tier")
  assert.equal(glm.label, "medium")
  assert.equal(glm.input, 136)

  const unknown = resolveModelFactors("totally-unknown-model-xyz", factors)
  assert.equal(unknown.source, "tier")
  assert.equal(unknown.label, "medium")
})

test("getCacheReadFactor: env override, invalid values fall back to the file", () => {
  assert.equal(getCacheReadFactor({ OPENCODE_CO2_CACHE_READ_FACTOR: "0.2" }), 0.2)
  assert.equal(getCacheReadFactor({ OPENCODE_CO2_CACHE_READ_FACTOR: "abc" }), 0.08)
  assert.equal(getCacheReadFactor({ OPENCODE_CO2_CACHE_READ_FACTOR: "0" }), 0.08)
  assert.equal(getCacheReadFactor({ OPENCODE_CO2_CACHE_READ_FACTOR: "-1" }), 0.08)
  assert.equal(getCacheReadFactor({}), 0.08)
})

test("loadFactors: throws on a malformed or incomplete factors file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "co2-factors-"))
  try {
    const bad = path.join(dir, "factors.json")
    await writeFile(bad, JSON.stringify({ version: 2, cacheReadFactor: -1, families: {}, tiers: {} }), "utf8")
    assert.throws(() => loadFactors(bad))
    await writeFile(bad, "{ not json", "utf8")
    assert.throws(() => loadFactors(bad))
    await writeFile(
      bad,
      JSON.stringify({ version: 2, cacheReadFactor: 0.08, families: { sonnet: { input: -1, output: 1 } }, tiers: {} }),
      "utf8",
    )
    assert.throws(() => loadFactors(bad))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("lifetimeStorageKey: versioned with the factors version", () => {
  assert.equal(lifetimeStorageKey(loadFactors()), "co2.lifetime.sessions.v2")
  assert.notEqual(lifetimeStorageKey({ ...loadFactors(), version: 3 }), lifetimeStorageKey(loadFactors()))
})
