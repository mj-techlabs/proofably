# Proofably — project context

## Why we're building it
The goal is to create an exceptional open-source developer tool with genuine technical differentiation and measurable developer value.

## Product thesis
Independently challenge code changes, regardless of whether a human, Codex, Claude Code, or another agent wrote them. Generate adversarial verification experiments, execute them in isolation, and report reproducible evidence of defects. Do not build a generic AI PR reviewer.

## Agreed architecture
- Local CLI first; no dependency on the original coding agent.
- Inputs: task/requirements, Git base revision, Git candidate revision, execution budget.
- Analyze changes and derive testable contracts, with uncertainty preserved.
- AI proposes tests and experiments; deterministic orchestration controls execution and records evidence.
- Run against separate disposable base/candidate workspaces; initially Docker.
- Compare results; reproduce suspicious findings; distinguish confirmed contract violations, unexplained differences, and unverified outcomes.
- Base behavior is not automatically correct; generated tests are not automatically correct.
- Output structured JSON and readable Markdown with reproduction steps.

## Security boundaries
Docker is a development isolation mechanism, not a sufficient hardened boundary for arbitrary hostile code. Avoid mounting host credentials, Docker socket, and writable source; restrict network, CPU, memory, processes, time, and filesystem. Hosted execution may need microVMs or stronger isolation.

## MVP scope
- TypeScript/Node.js, Git, Docker, local CLI.
- Initially focus on deterministic functions and business logic; exclude databases, external networks, distributed systems, arbitrary complex builds.
- One configurable model/provider initially, without assuming a particular coding agent.
- Keep verification bounded (~3–5 minutes per run as an initial target).
- Apache-2.0 was proposed, but ownership/employment IP terms and license selection must be confirmed before public release.

## Current repository state
A starter prototype was created with a Node.js CLI, two-revision Docker execution, output/exit-code comparison, JSON report, and unit tests. It is NOT yet an AI-powered verifier; Docker integration was not exercised in the creation environment. Inspect source before trusting this summary.

## Validation
Compare against existing tests and a conventional LLM code review on held-out, real defects. Measure unique defects found, false positives, reproduction rate, latency, and cost. A reproducible behavior difference is not necessarily a confirmed bug. No benchmark results have yet been established.

## Delivery approach
Prioritize a small, technically meaningful proof of concept before SaaS, integrations, or public launch.

## Next suggested task
Inspect the existing starter, run its tests, identify the missing AI experiment-planning interface, and propose a small implementation plan. Do not begin a large refactor without discussing it.
