# Autoresearch: pi-council self-evaluation

## Goal
Use pi-council (spawn_council) to get multi-model feedback on the pi-council codebase itself.
Collect suggestions, implement the best ones, and re-evaluate to see if agents find fewer issues.

## Primary Metric
- `issues_found` — number of actionable issues/suggestions raised by the council (lower is better)
- As we fix real issues, subsequent council runs should surface fewer problems

## Process
1. Run spawn_council asking models to review the codebase and list concrete issues
2. Tally the unique actionable issues found
3. Implement the top suggestions
4. Re-run the council to see if the issue count drops
5. Repeat

## Rules
- Do NOT fake improvements — only count genuine fixes
- Do NOT overfit to specific model phrasing — fix real code quality issues
- Each council run should use the same evaluation prompt for consistency
- Track which suggestions came from which models
