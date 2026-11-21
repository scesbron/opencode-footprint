/** @jsxImportSource @opentui/solid */
// TUI plugin: session eco grade + CO2/kWh on one line, all-time (cross-
// session) totals on a second line, appended beside the built-in sidebar
// footer. All math lives in lib/ (unit-tested plain .ts modules); this file
// only wires reactive reads to those pure functions and renders strings.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createResource, Show } from "solid-js"
import {
  getGridIntensity,
  summarizeLifetime,
  type LifetimeSessionTotal,
  type UsageMessage,
} from "./lib/co2-core.ts"
import { lifetimeStorageKey, loadFactors } from "./lib/co2-factors.ts"
import { computeSessionCo2, formatLifetimeLine, formatSessionLine, mergeSessionMessages } from "./lib/co2-sidebar-logic.ts"

type TuiContext = Plugin.Context

// Versioned with the factors: bump factors.json's version and the all-time
// total starts fresh instead of mixing grams computed with old factors.
const STORAGE_KEY = lifetimeStorageKey(loadFactors())

function Footer(props: { context: TuiContext; sessionID: string }) {
  const context = props.context
  const [stored, updateStored] = context.storage.store<Record<string, LifetimeSessionTotal>>(STORAGE_KEY, {
    initial: {},
  })

  // The data layer seeds a resumed session with its trailing page only (the
  // host syncs ~20 messages), so the full history is fetched once per
  // session switch and overlaid with the reactive live list below.
  const [fullHistory] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const collected: UsageMessage[] = []
      let cursor: string | undefined
      do {
        const response = await context.client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : {}) })
        collected.push(...response.data)
        cursor = response.cursor.next ?? undefined
      } while (cursor)
      return collected
    },
  )

  // Seed the live page once; it then grows reactively as messages stream.
  void context.data.session.message.sync(props.sessionID)

  const session = createMemo(() => {
    const baseline = fullHistory.latest ?? []
    const live = context.data.session.message.list(props.sessionID) ?? []
    return computeSessionCo2(mergeSessionMessages(baseline, live), getGridIntensity(), loadFactors())
  })

  // Upsert this session's running total (never accumulate a delta): repeated
  // re-renders, reloads and replayed events all recompute the same total, so
  // overwriting keeps it from ever being double-counted. Skip persisting
  // before the first assistant message -- that would record a {0,0} entry
  // for every session merely opened and inflate the lifetime session count.
  createEffect(() => {
    if (session().messages === 0) return
    void updateStored((draft) => {
      draft[props.sessionID] = { grams: session().co2Grams, kwh: session().energyKwh }
    })
  })

  // Display value merges the durable map with this session's current total,
  // speculatively, so the number never lags a tick behind the write above.
  const lifetime = createMemo(() =>
    summarizeLifetime({
      ...stored,
      [props.sessionID]: { grams: session().co2Grams, kwh: session().energyKwh },
    }),
  )

  return (
    <Show when={session().messages > 0}>
      <box flexDirection="column">
        <text fg={context.theme.text.base}>{formatSessionLine(session())}</text>
        <text fg={context.theme.text.muted}>{formatLifetimeLine(lifetime())}</text>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-footprint.co2-sidebar",
  setup(context) {
    // `append` coexists with the built-in footer: V2 slots compose, so the
    // host's own footer content stays visible (the V1 plugin replaced it).
    return context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => <Footer context={context} sessionID={sessionID} />,
    })
  },
})
