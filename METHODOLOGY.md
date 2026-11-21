# Methodology

Emissions are estimated from token counts with per-kind, per-family energy
factors. The approach follows [claude-carbon](https://github.com/gwittebolle/claude-carbon)
(MIT, gwittebolle), whose factors are fitted on Jegham et al., *How Hungry is
AI? Benchmarking Energy, Water, and Carbon Footprint of LLM Inference*
([arXiv:2505.09598](https://arxiv.org/abs/2505.09598), v6). This file records
what is measured, what is extrapolated, and what the estimate does not cover.
Review date: 2027-03.

## Formula

```
per_model_energy (Wh) = (input + cache_write) * f_in
                     + cache_read * f_in * cache_read_factor
                     + (output + reasoning) * f_out
session_energy (kWh)  = sum(per_model_energy) / 1000
CO2 (g)               = session_energy (kWh) * grid_intensity (gCO2/kWh)
```

Factors are **Wh per million tokens, PUE included** (AWS 2025 fleet: 1.14).
A cache write is a full prefill, so it counts at the input factor; a cache
read skips most of that prefill and pays a residual fraction; decoding is
memory-bandwidth-bound and costs far more per token than prefill. Reasoning
tokens bill at the output factor: measured energy per generated token is the
same inside and outside the reasoning trace to within 3.4% (Pasandi & Nadeem,
HotCarbon 2026).

## Factors

| Family / tier | f_in (Wh/Mtok) | f_out (Wh/Mtok) | Source |
|---|---|---|---|
| sonnet | 136 | 2878 | Jegham v6, 3-point OLS fit for Claude-3.7 Sonnet (0.950 / 2.989 / 5.671 Wh per query, PUE included), converted from claude-carbon's 39 / 826 gCO2e/Mtok at CIF 0.287 |
| haiku | 35 | 722 | 0.25x sonnet, between EcoLogits' floor (~0.07x) and a speed-ratio ceiling (~0.57x) |
| opus | 272 | 5756 | 2x sonnet; honest band 2x-5x (unmeasured) |

The tiers `small` / `medium` / `large` reuse the haiku / sonnet / opus
numbers as the fallback for models without a known family: `classifyModel`
maps markers (`haiku`, `mini`, `nano`, `flash`, `lite` -> small; `opus`, `o3`
-> large) and everything unknown defaults to medium. The output:input ratio
is ~21:1 for the sonnet fit; a flat per-token rate misses both this
asymmetry and the cache-read discount, which is why cache-heavy agentic
sessions estimate ~75x lower under this model than under the previous flat
rates.

All factors live in [`.opencode/plugins/co2-footprint/lib/factors.json`](.opencode/plugins/co2-footprint/lib/factors.json):
edit the file to experiment. **Bump `version` when you change a factor** --
the sidebar's all-time total is keyed by that version, so your accumulated
grams never mix formulas.

## Cache-read factor

Default **0.08**, published range **0.05-0.20** (override with
`OPENCODE_CO2_CACHE_READ_FACTOR`). A direct measurement exists: Irminsul
([arXiv:2605.05696](https://arxiv.org/abs/2605.05696)) instruments prefill
energy per cache hit/miss with NVML counters and finds hits at 14-37% of
miss energy (GQA/MLA/MHA). The measurement is at 4,096 prefix tokens while a
median agentic step carries ~126k: fixed kernel-launch costs dominate small
cells and amortize away at scale, so 0.08 sits below the measured range on
purpose. Treating cache reads as free understates a real memory-bandwidth
cost; treating them as full prefill overstates it ~12x. This term is a
prefill residual, not the decode-phase KV re-read, which is not modelled
(see Limitations).

## Grid intensity

Default **400 gCO2/kWh** (IEA global average), override with
`OPENCODE_CO2_GRID_INTENSITY` -- e.g. ~50 for France, ~700 for Poland
([Electricity Maps](https://app.electricitymaps.com)). The energy is stored
and displayed separately from the conversion, so changing your grid never
invalidates the energy estimate.

## Equivalents

| Row | Factor | Source |
|---|---|---|
| Smartphone charges | 8.7 gCO2e per charge | EPA per-charge energy (0.019 kWh) x Ember 2025 world intensity (458 gCO2/kWh) |
| 10W LED bulb minutes | energy-denominated | correct under any grid intensity |
| km driven | 200 gCO2/km | GFEI/IEA 167 gCO2/km rated x ~20% on-road gap (JRC OBFCM) |

The previous "Google searches" (0.2 g) and "video streaming" rows were
removed: both traced to unsourced blog figures, and claude-carbon removed
the searches row for the same reason.

## Limitations

- **Order of magnitude only.** Not a carbon report, not for regulatory use.
  Combining the documented bands (opus 2x-5x, cache-read 0.05-0.20) the
  plausible range around a displayed total is roughly 0.7x-3x.
- **Inference only.** Training, embodied hardware and cooling water are
  excluded.
- **Grid-average, not real-time.** The true grid mix of the serving data
  center is unknown and varies by region and hour.
- **The decode-phase context term is not modelled.** Each generated token
  re-reads the KV cache of its whole context; energy per output token grows
  with context length (2-3x from 1k to 16k context in the literature). Long
  agentic sessions therefore lean toward the *low* side of the estimate.
- **Sonnet is the only directly fitted family.** Haiku and opus are
  extrapolations with the bands above; non-Anthropic models fall to tier
  classification until a benchmark covers them.

Credit: the formula shape, the factor derivation, the cache-read term and
the equivalents discipline are taken from claude-carbon's methodology
(MIT, gwittebolle), used here with conversion to the energy/intensity
split this plugin keeps configurable.
