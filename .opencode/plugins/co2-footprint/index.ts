// V2 server plugin: the `co2_report` tool.
//
// All pure logic lives under lib/ (co2-core.ts, co2-report.ts); this file is
// wiring: register the tool through ctx.tool.transform, read the session's
// full message history via ctx.session.context, and hand the messages to the
// report builder. The report is rebuilt from history on every call, so it
// covers resumed sessions and messages sent before this process started.
import { Plugin } from "@opencode/plugin"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { getGridIntensity, type UsageMessage } from "./lib/co2-core.ts"
import { buildReportData, buildSessionStats, formatReport } from "./lib/co2-report.ts"

const NO_DATA_MESSAGE =
  "No usage data recorded yet for this session. " +
  "Start a conversation and check back -- your eco report will be waiting!"

// V1 consumed `m.info`; V2's SessionMessageInfo may be bare. The structural
// UsageMessage view validates every field, so both shapes are accepted.
const usage = (message: unknown): UsageMessage | null => {
  if (message == null || typeof message !== "object") return message as null
  return ("info" in message ? (message as { info: unknown }).info : message) as UsageMessage
}

export default Plugin.define({
  id: "opencode-footprint.co2-tracker",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "co2_report",
        description:
          "Shows the estimated CO2 carbon footprint of the current OpenCode session. " +
          "Generates an eco report with session grade (A+ to F), carbon footprint breakdown, " +
          "real-world equivalents, token usage, and actionable tips to code greener. " +
          "Call this tool when the user asks about CO2, carbon footprint, " +
          "environmental impact, or energy usage of their session. " +
          'Pass `export: "json"` or `export: "markdown"` to also write the report ' +
          "to a co2-report file in the project directory.",
        input: {
          type: "object",
          properties: {
            export: {
              type: "string",
              enum: ["json", "markdown"],
              description: "Also write the report to co2-report.<ext> in the project directory.",
            },
          },
          additionalProperties: false,
        },
        async execute(args, context) {
          const { export: exportArg } = args as { export?: "json" | "markdown" }
          let response: readonly unknown[]
          try {
            response = await ctx.session.context({ sessionID: context.sessionID })
          } catch (error) {
            const reason = error instanceof Error ? error.message : JSON.stringify(error)
            return { content: `Could not read this session's messages: ${reason}` }
          }

          const stats = buildSessionStats([...response].map(usage))
          if (stats.messages === 0) return { content: NO_DATA_MESSAGE }

          const data = buildReportData(stats, getGridIntensity())
          const report = formatReport(data)
          if (!exportArg) return { content: report }

          const ext = exportArg === "json" ? "json" : "md"
          const content = exportArg === "json" ? JSON.stringify(data, null, 2) : report
          const filePath = path.join(ctx.location.directory, `co2-report.${ext}`)
          await writeFile(filePath, content, "utf8")
          return { content: `${report}\n\n*Exported to \`${filePath}\`*` }
        },
      })
    })
  },
})
