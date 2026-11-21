// Pure CO2 model shared by the server plugin (index.ts), the TUI sidebar
// (tui.tsx) and the unit tests. Kept free of host-API imports so it stays
// unit-testable.
//
// ---------------------------------------------------------------------------
// CO2 emission model
// ---------------------------------------------------------------------------
// Energy factors live in factors.json (see co2-factors.ts): Wh per million
// tokens, PUE included, per model family and token kind. The per-kind
// weighting follows the claude-carbon methodology, fitted on Jegham et al.
// "How Hungry is AI?" (2025, arXiv:2505.09598) -- see METHODOLOGY.md for
// sources, uncertainty bands and limits.
//
// These are rough estimates. Real values depend on hardware, data center
// location, cooling, and model architecture. Users can override the grid
// carbon intensity via OPENCODE_CO2_GRID_INTENSITY and the cache-read factor
// via OPENCODE_CO2_CACHE_READ_FACTOR.
// ---------------------------------------------------------------------------
import { getCacheReadFactor, resolveModelFactors, type Factors } from "./co2-factors.ts"

// Default grid carbon intensity (gCO2 per kWh).
// Global average ≈ 400. Override with OPENCODE_CO2_GRID_INTENSITY.
export const DEFAULT_GRID_INTENSITY = 400

export function getGridIntensity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCODE_CO2_GRID_INTENSITY
  if (raw) {
    const parsed = parseFloat(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_GRID_INTENSITY
}

// ---------------------------------------------------------------------------
// Eco scoring: assigns a letter grade based on CO2 per message
// ---------------------------------------------------------------------------

export interface EcoGrade {
  grade: string
  label: string
  level: number // 1-10 impact level (lower = greener)
  tip: string
}

// Calibrated for the per-kind energy model: a cache-heavy agentic session
// lands ~75x lower than under the old flat rates, so the scale moves with it
// (values are the old thresholds divided by ten, locked by the golden
// vectors).
const ECO_THRESHOLDS: readonly { maxPerMsg: number; grade: EcoGrade }[] = [
  {
    maxPerMsg: 0.01,
    grade: { grade: "A+", label: "Exemplary", level: 1, tip: "Your session is incredibly efficient. Keep it up!" },
  },
  {
    maxPerMsg: 0.03,
    grade: { grade: "A", label: "Excellent", level: 2, tip: "Great efficiency! Small models and focused prompts pay off." },
  },
  {
    maxPerMsg: 0.08,
    grade: { grade: "B", label: "Good", level: 3, tip: "Solid session. Consider using smaller models for simpler tasks." },
  },
  {
    maxPerMsg: 0.15,
    grade: { grade: "B-", label: "Above Average", level: 4, tip: "Not bad! Try batching questions to reduce message overhead." },
  },
  {
    maxPerMsg: 0.3,
    grade: { grade: "C", label: "Moderate", level: 6, tip: "Consider using a smaller model for routine tasks to cut emissions." },
  },
  {
    maxPerMsg: 0.6,
    grade: {
      grade: "D",
      label: "High Impact",
      level: 8,
      tip: "This session is carbon-heavy. Smaller models can reduce your footprint by up to 10x.",
    },
  },
  {
    maxPerMsg: Infinity,
    grade: {
      grade: "F",
      label: "Very High Impact",
      level: 10,
      tip: "Consider breaking work into smaller sessions and using efficient models.",
    },
  },
]

export function getEcoGrade(co2Grams: number, messages: number): EcoGrade {
  const perMsg = messages > 0 ? co2Grams / messages : 0
  return (ECO_THRESHOLDS.find((t) => perMsg <= t.maxPerMsg) ?? ECO_THRESHOLDS[ECO_THRESHOLDS.length - 1]).grade
}

export function impactBar(level: number): string {
  const max = 10
  const filled = Math.min(Math.max(level, 0), max)
  return "[" + "█".repeat(filled) + "░".repeat(max - filled) + "]"
}

// ---------------------------------------------------------------------------
// Token aggregation over the host's message history
// ---------------------------------------------------------------------------

export interface ModelTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function emptyModelTokens(): ModelTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addModelTokens(a: ModelTokens, b: ModelTokens): ModelTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

// Structural view of the host's message shapes. The V2 host sends
// SessionMessageInfo (`type`, `model: { id, providerID }`, tokens and cost at
// the top level); the older flat SDK shape (`role`, `modelID`) is still
// accepted. Every field is optional and `unknown`, so partially populated
// (streaming or malformed) records are accepted, and every value is
// validated before use.
export interface UsageMessage {
  role?: unknown
  type?: unknown
  modelID?: unknown
  model?: { id?: unknown; providerID?: unknown }
  providerID?: unknown
  cost?: unknown
  tokens?: {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
  time?: { created?: unknown; completed?: unknown }
}

export function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function isAssistant(message: UsageMessage | null | undefined): message is UsageMessage {
  return message?.role === "assistant" || message?.type === "assistant"
}

function messageModelID(message: UsageMessage): string {
  if (typeof message.modelID === "string") return message.modelID
  if (typeof message.model?.id === "string") return message.model.id
  return "unknown"
}

export function messageProviderID(message: UsageMessage): string | undefined {
  if (typeof message.providerID === "string") return message.providerID
  if (typeof message.model?.providerID === "string") return message.model.providerID
  return undefined
}

function messageTokens(message: UsageMessage): ModelTokens {
  return {
    input: safeNumber(message.tokens?.input),
    output: safeNumber(message.tokens?.output),
    reasoning: safeNumber(message.tokens?.reasoning),
    cacheRead: safeNumber(message.tokens?.cache?.read),
    cacheWrite: safeNumber(message.tokens?.cache?.write),
  }
}

export function aggregateTokensByModel(messages: readonly (UsageMessage | null | undefined)[]): Map<string, ModelTokens> {
  return messages.filter(isAssistant).reduce((byModel, message) => {
    return byModel.set(messageModelID(message), addModelTokens(byModel.get(messageModelID(message)) ?? emptyModelTokens(), messageTokens(message)))
  }, new Map<string, ModelTokens>())
}

export function countAssistantMessages(messages: readonly (UsageMessage | null | undefined)[]): number {
  return messages.filter(isAssistant).length
}

// ---------------------------------------------------------------------------
// Energy / CO2 computation
// ---------------------------------------------------------------------------

export interface ModelEnergyBreakdown {
  modelID: string
  tokens: number
  energyKwh: number
}

// Per-model energy: (input + cacheWrite) * input factor (a cache write is a
// full prefill), cacheRead * input factor * cacheReadFactor (the prefill
// residual a reused prefix still pays), and (output + reasoning) * output
// factor (decoding is memory-bandwidth-bound, ~21x an input token for the
// sonnet class). Factors are Wh/Mtok with PUE included, so no separate PUE
// multiplier applies. Energy model from Jegham et al. 2025 via the
// claude-carbon methodology; see METHODOLOGY.md for sources and limits.
export function computeModelEnergyBreakdown(
  tokensByModel: ReadonlyMap<string, ModelTokens>,
  factors: Factors,
  cacheReadFactor = getCacheReadFactor(),
): ModelEnergyBreakdown[] {
  return [...tokensByModel.entries()].map(([modelID, tokens]) => {
    const resolved = resolveModelFactors(modelID, factors)
    const wh =
      ((tokens.input + tokens.cacheWrite) * resolved.input +
        tokens.cacheRead * resolved.input * cacheReadFactor +
        (tokens.output + tokens.reasoning) * resolved.output) /
      1e6
    const total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
    return { modelID, tokens: total, energyKwh: wh / 1000 }
  })
}

export function sumEnergyKwh(breakdown: readonly ModelEnergyBreakdown[]): number {
  return breakdown.reduce((sum, b) => sum + b.energyKwh, 0)
}

// ---------------------------------------------------------------------------
// Real-world equivalents
// ---------------------------------------------------------------------------

export interface Equivalents {
  phoneCharges: number
  ledBulbMinutes: number
  kmDriven: number
}

// A 10W LED bulb draws 10 Wh per hour, i.e. 10/60 Wh per minute.
const LED_BULB_WH_PER_MINUTE = 10 / 60

// Smartphone charge: EPA's published per-charge energy (0.019 kWh) at the
// world grid intensity (Ember 2025, 458 gCO2/kWh) = 8.7 gCO2e per charge.
const PHONE_CHARGE_GCO2 = 8.7

// World-average car, real-world estimate: GFEI/IEA 167 gCO2/km rated, plus
// the ~20% on-road gap, = 200 gCO2/km.
const CAR_GCO2_PER_KM = 200

// CO2-denominated equivalents scale with the grid intensity. The LED bulb
// runs on the same grid as the data center, so it is compared in energy
// terms: that keeps it correct for any OPENCODE_CO2_GRID_INTENSITY.
export function computeEquivalents(co2Grams: number, energyKwh: number): Equivalents {
  return {
    phoneCharges: co2Grams / PHONE_CHARGE_GCO2,
    ledBulbMinutes: (energyKwh * 1000) / LED_BULB_WH_PER_MINUTE,
    kmDriven: co2Grams / CAR_GCO2_PER_KM,
  }
}

// ---------------------------------------------------------------------------
// Cross-session (lifetime) totals: pure reducer over a persisted
// per-session map. TUI-side callers (the sidebar) persist this shape via
// api.kv. This module only owns the math so it stays testable.
// ---------------------------------------------------------------------------

export interface LifetimeSessionTotal {
  grams: number
  kwh: number
}

export type LifetimeSessions = Readonly<Record<string, LifetimeSessionTotal>>

// Overwrites (not adds to) this session's entry with its current running
// total. Idempotent by design: re-renders, TUI restarts, and replayed
// message events all recompute the same session total from scratch, so
// upserting instead of accumulating deltas means a session can never be
// double-counted into the lifetime sum.
export function upsertLifetimeSession(
  sessions: LifetimeSessions,
  sessionID: string,
  total: LifetimeSessionTotal,
): LifetimeSessions {
  return { ...sessions, [sessionID]: total }
}

export interface LifetimeSummary {
  grams: number
  kwh: number
  sessions: number
}

export function summarizeLifetime(sessions: LifetimeSessions): LifetimeSummary {
  const totals = Object.values(sessions)
  return {
    grams: totals.reduce((sum, t) => sum + t.grams, 0),
    kwh: totals.reduce((sum, t) => sum + t.kwh, 0),
    sessions: totals.length,
  }
}
