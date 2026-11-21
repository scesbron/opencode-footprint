// Pure logic backing the TUI sidebar panel (tui.tsx). Kept in its own plain
// .ts module (no JSX) so it can be unit tested directly. The component only
// renders precomputed strings from here.
import type { Factors } from "./co2-factors.ts"
import {
  aggregateTokensByModel,
  computeModelEnergyBreakdown,
  countAssistantMessages,
  getEcoGrade,
  sumEnergyKwh,
  type LifetimeSummary,
  type UsageMessage,
} from "./co2-core.ts"

export interface SessionCo2Summary {
  grade: string
  co2Grams: number
  energyKwh: number
  messages: number
}

export function computeSessionCo2(
  messages: readonly (UsageMessage | null | undefined)[],
  gridIntensityGco2PerKwh: number,
  factors: Factors,
): SessionCo2Summary {
  const energyKwh = sumEnergyKwh(computeModelEnergyBreakdown(aggregateTokensByModel(messages), factors))
  const co2Grams = energyKwh * gridIntensityGco2PerKwh
  const assistantMessages = countAssistantMessages(messages)
  const grade = getEcoGrade(co2Grams, assistantMessages)
  return { grade: grade.grade, co2Grams, energyKwh, messages: assistantMessages }
}

export function formatSessionLine(summary: SessionCo2Summary): string {
  return `${summary.grade}  ${formatMass(summary.co2Grams)} CO2  ${summary.energyKwh.toFixed(4)} kWh`
}

// Pick the unit that matches the magnitude: grams below 1 kg, kilograms
// below 1 t, tonnes beyond, with decimals that shrink as the number grows.
export function formatMass(grams: number): string {
  if (grams >= 1_000_000) return `${(grams / 1_000_000).toFixed(2)} t`
  if (grams >= 1_000) return `${(grams / 1_000).toFixed(2)} kg`
  if (grams >= 100) return `${grams.toFixed(0)} g`
  if (grams >= 10) return `${grams.toFixed(1)} g`
  return `${grams.toFixed(2)} g`
}

export function formatLifetimeLine(lifetime: LifetimeSummary): string {
  return `lifetime: ${formatMass(lifetime.grams)}`
}

// Overlay the TUI's live trailing page onto the full-history baseline: the
// data layer seeds a resumed session with its last page only, so the
// sidebar fetches the complete history itself and lets fresher live
// entries (same id) win. Messages without ids are kept as-is.
export function mergeSessionMessages(
  baseline: readonly UsageMessage[],
  live: readonly UsageMessage[],
): UsageMessage[] {
  const byKey = new Map<string, UsageMessage>()
  const loose: UsageMessage[] = []
  const put = (message: UsageMessage): void => {
    if (typeof message.id === "string") byKey.set(message.id, message)
    else loose.push(message)
  }
  baseline.forEach(put)
  live.forEach(put)
  return [...byKey.values(), ...loose]
}
