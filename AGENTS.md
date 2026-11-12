# Bot quickstart command guide

`bot/QUICKSTART_README.md` is the owner's personal command guide. Only change its
contents or command order when the owner explicitly requests changes to this
guide. Do not populate it from other documentation, rewrite it during routine
bot updates, or replace it with generated documentation. The owner will specify
which commands to include and their order.

# Codex Working Guidelines

## Efficiency and Token Usage

This is a large project. Minimize unnecessary token consumption without compromising correctness, thoroughness, security, or reliability.

- Start with targeted searches and relevant files. Expand when necessary.
- Inspect only relevant files, avoid repository-wide audits for small changes, and run targeted tests to substantially reduce usage.
- Avoid redundant file reads, commands, tests, and lengthy explanations.
- Consult existing project documentation rather than rediscovering or duplicating information.
- Keep changes focused and avoid unrelated refactoring.

## Debugging and Performance

- Investigate root causes, not just symptoms.
- Trace relevant systems end to end when necessary, including database, caching, concurrency, and infrastructure.
- Consider edge cases, regressions, and both low-traffic and high-concurrency performance.
- Prioritize findings by impact, evidence, risk, and implementation effort.
- Distinguish confirmed problems from hypotheses.
- Never restrict investigation depth simply to save tokens.

## Implementation and Safety

- Follow existing project documentation and preserve all established safeguards, especially those protecting financial operations and data integrity.
- Never weaken safeguards for performance, simplicity, or token savings.
- Favor maintainable solutions consistent with the existing architecture.
- Run targeted tests first, expanding verification when changes are complex, shared, or high-risk.
- Do not deploy production changes without explicit authorization.

## Core Principle

**Minimize unnecessary work, not necessary investigation.** Be efficient with simple tasks and thorough with complex or high-risk ones.
