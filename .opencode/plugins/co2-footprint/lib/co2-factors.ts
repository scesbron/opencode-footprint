// The editable heart of the CO2 model: factors.json, beside this module, is
// the single place to tune the estimate. Factors are energy per million
// tokens, in Wh, PUE included (Jegham et al. 2025 for the sonnet family,
// extrapolations documented in METHODOLOGY.md). A malformed file fails loudly
// at load rather than silently producing zeros -- a bad edit should be
// visible the moment a report is next computed.
import { readFileSync } from "node:fs"

export type ModelSize = "small" | "medium" | "large"

// Exceptions to the token rules in classifyModel(). Only models whose family
// markers would classify them wrongly need an entry here. An entry matches the
// bare name and its dash-suffixed variants ("o4-mini-high", "o3-mini-2025-01-31").
const MODEL_SIZE: Readonly<Record<string, ModelSize>> = {
  // OpenAI reasoning minis are mid-sized despite the "mini" marker.
  "o3-mini": "medium",
  "o4-mini": "medium",
}

// Family markers, matched against whole id segments (never substrings: the
// "mini" in "gemini" must not make every Gemini model small).
const SMALL_MARKERS: ReadonlySet<string> = new Set(["haiku", "mini", "nano", "flash", "lite"])
const LARGE_MARKERS: ReadonlySet<string> = new Set(["opus", "o3"])

// Model ids arrive in many shapes: bare ("claude-opus-4-5"), provider
// prefixed ("openrouter/google/gemini-2.5-pro"), or vendor qualified
// ("anthropic.claude-haiku-4-5-20251001-v1:0"). Keep the last path segment
// for the exceptions table, and split everything on separators for markers.
export function classifyModel(modelID: string): ModelSize {
  const id = modelID.toLowerCase()
  const name = id.slice(id.lastIndexOf("/") + 1)
  const exception = Object.entries(MODEL_SIZE).find(
    ([key]) => name === key || name.startsWith(`${key}-`),
  )
  if (exception) return exception[1]
  const segments = id.split(/[-/._:@\s]+/)
  if (segments.some((s) => SMALL_MARKERS.has(s))) return "small"
  if (segments.some((s) => LARGE_MARKERS.has(s))) return "large"
  return "medium"
}

export interface EnergyFactors {
  input: number
  output: number
}

export interface Factors {
  version: number
  cacheReadFactor: number
  families: Record<string, EnergyFactors>
  overrides: Record<string, string>
  tiers: Record<ModelSize, EnergyFactors>
}

export interface ResolvedModelFactors {
  source: "override" | "family" | "tier"
  label: string
  input: number
  output: number
}

const DEFAULT_PATH = new URL("./factors.json", import.meta.url)
let cached: Factors | undefined

function invalid(reason: string): Error {
  return new Error(`Invalid factors file: ${reason}`)
}

function validate(raw: unknown): Factors {
  if (raw == null || typeof raw !== "object") throw invalid("not a JSON object")
  const factors = raw as Partial<Factors>
  if (!Number.isFinite(factors.version) || (factors.version ?? 0) <= 0) {
    throw invalid("version must be a positive number")
  }
  if (!Number.isFinite(factors.cacheReadFactor) || (factors.cacheReadFactor ?? 0) <= 0) {
    throw invalid("cacheReadFactor must be a positive number")
  }
  if (factors.families == null || typeof factors.families !== "object" || Array.isArray(factors.families)) {
    throw invalid("families must be an object of energy factors")
  }
  const entries = [...Object.entries(factors.families ?? {}), ...Object.entries(factors.tiers ?? {})]
  for (const [name, entry] of entries) {
    if (entry == null || !Number.isFinite(entry.input) || entry.input <= 0 || !Number.isFinite(entry.output) || entry.output <= 0) {
      throw invalid(`entry "${name}" needs positive input and output factors`)
    }
  }
  for (const tier of ["small", "medium", "large"] as const) {
    if (factors.tiers?.[tier] == null) throw invalid(`missing tier "${tier}"`)
  }
  for (const [model, family] of Object.entries(factors.overrides ?? {})) {
    if (typeof family !== "string" || factors.families?.[family] == null) {
      throw invalid(`override "${model}" points at unknown family "${String(family)}"`)
    }
  }
  return factors as Factors
}

export function loadFactors(filePath: string | URL = DEFAULT_PATH): Factors {
  if (filePath === DEFAULT_PATH && cached) return cached
  const factors = validate(JSON.parse(readFileSync(filePath, "utf8")))
  if (filePath === DEFAULT_PATH) cached = factors
  return factors
}

// Resolution order: model overrides (longest key first, so "glm-5.3-flash"
// is not captured by "glm-5.3"; a key matches the last path segment exactly
// or as its dash prefix), then family markers as whole id segments, then
// the size-tier fallback.
export function resolveModelFactors(modelID: string, factors: Factors): ResolvedModelFactors {
  const id = modelID.toLowerCase()
  const name = id.slice(id.lastIndexOf("/") + 1)
  const override = Object.keys(factors.overrides ?? {})
    .sort((a, b) => b.length - a.length)
    .find((key) => name === key || name.startsWith(`${key}-`))
  if (override) {
    const family = factors.overrides[override]
    return { source: "override", label: family, ...factors.families[family] }
  }
  const segments = new Set(id.split(/[-/._:@\s]+/))
  const family = Object.keys(factors.families).find((key) => segments.has(key))
  if (family) return { source: "family", label: family, ...factors.families[family] }
  const tier = classifyModel(modelID)
  return { source: "tier", label: tier, ...factors.tiers[tier] }
}

export function getCacheReadFactor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCODE_CO2_CACHE_READ_FACTOR
  if (raw) {
    const parsed = parseFloat(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return loadFactors().cacheReadFactor
}

// The lifetime sidebar total is keyed by the factors version: bump the
// version when you change a factor, and the all-time figure starts fresh
// instead of mixing grams computed with different factors.
export function lifetimeStorageKey(factors: Factors): string {
  return `co2.lifetime.sessions.v${factors.version}`
}
