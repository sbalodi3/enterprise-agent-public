# Wage-evidence pilot

English | [中文](README.zh.md)

Use synthetic claims only. The coordinator records the examiner who verified each answer key and the date before enrolling anyone. The keys below are fixture-authored until that review occurs. Use a separate browser profile for each coded participant. Sign in as the synthetic adjuster Maya. Run the study on a dedicated copy of the showcase if its existing portfolio totals are important.

## Preparation

Enable `CLAIMS_WAGE_REVIEW=1` on Workbench, build the claims image and start the showcase with its configured local model. To stage the eight synthetic cases, run `"${CONTAINER_ENGINE:-docker}" exec enterprise-agent-showcase-workbench-1 node claims/showcase/wage-study/seed.mjs`. Rerunning the seed preserves existing records. Open each file in Workbench and verify its Sources tab. Exercise the pilot button once on a separate practice file (WC-102). The baseline arm uses the current Workbench sources and timeline. The assisted arm starts in the same Workbench location and uses **Review missing wage evidence**. Use the identical instruction in both arms: “Identify the requested period, what remains missing, and any conflicting evidence. Show the passages that support your answer.”

## Session schedule and answer key

Recruit eight adjusters. Each reviews four cases, one from each pair, twice per interface. For odd participant numbers use the March case of each pair and alternate baseline, assisted, baseline, assisted. For even numbers use the April cases and the opposite interfaces. For participants 3, 4, 7, and 8 swap March and April; for participants 5 through 8 reverse the case order and retain the original assignment for each pair. Keep answers concealed from participants. Record a five-minute timeout as unfinished. Start at task reveal, including inference wait, and stop on the first correct gap assessment before asking for source demonstrations. Do not coach. Record initial incorrect assessments even when later corrected.

| Pair | March / April claims | Expected assessment and source check |
|---|---|---|
| A | WC-951 / WC-952 | Request covers days 1–21. No payroll return in the file. Open the request and check the document inventory. |
| B | WC-953 / WC-954 | Days 1–7 documented. Days 8–21 outstanding. Open the request and first return. |
| C | WC-955 / WC-956 | Returns cover days 1–14 and 8–21. All 21 unique days documented. Open the request and both returns. |
| D | WC-957 / WC-958 | All 21 days documented. Identical periods have gross amounts of USD 1,800 and USD 2,100. The amount is unresolved. Open both returns and the request. |

## Scorecard

Use the [trial scorecard](scorecard.md) to enter the assigned tasks and review sign-off. For each task record participant code, case, arm, first assessment correct (yes/no), seconds to correct assessment or unfinished, expected source passages, passages the participant correctly opened, displayed facts checked, correct fact-to-passage mappings, and fixed-layout fallback (yes/no). Record only these study fields, using synthetic IDs. Exclude identifiers and claim text from operational telemetry. The UI exposes the layout mode in the wage review section’s `data-layout` attribute. Record SDK/render failures separately.

For each participant calculate the median seconds of correct completed tasks per arm and the paired percentage improvement `100 × (baseline − assisted) / baseline`. Report the median of these paired improvements, its range, and the number of evaluable pairs. Report initial-assessment accuracy and unfinished counts over **all** assigned tasks. Do not make an expansion decision with missing participant pairs. Report participant source-opening success and fallback rate separately. Expand only if median paired improvement is at least 20%, assisted accuracy meets or exceeds baseline, and every displayed material fact maps to the correct passage(s). A gap needs the request and applicable returns; an absence judgment also requires checking the inventory. Keep A2UI behind the pilot flag if a gate fails.
