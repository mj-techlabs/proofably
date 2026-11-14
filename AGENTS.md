# Instructions for coding agents

Read `docs/PROJECT_CONTEXT.md` before planning changes. Treat it as product context, not proof that features are implemented.

- Build an open-source, agent-agnostic independent code verifier.
- Keep AI reasoning separate from deterministic execution and evidence evaluation.
- Never claim a defect is confirmed solely because an LLM or generated test says so.
- Use isolated, disposable execution environments. Do not mount host credentials or Docker socket into untrusted runners.
- Keep changes small, tested, and reproducible; report which tests were actually run.
- Do not add cloud services, telemetry, paid dependencies, or public publishing steps without approval.
- Do not assume the current prototype already generates AI tests.
- When making architectural decisions, document alternatives and tradeoffs.
