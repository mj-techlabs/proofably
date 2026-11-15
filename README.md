# Proofably

An experimental, agent-independent verification engine for code changes.

**Current status: experimental foundation, not yet an AI verifier.** The v0.1 prototype executes a supplied list of commands against two Git revisions in separate Docker containers and reports observable differences. It does not generate tests, infer requirements, or prove defects yet.

## Quick start

Requirements: Node.js 20+, Docker daemon, Git. Run from the Git repository you want to verify.

```sh
node /path/to/proofably/src/cli.js check \
  --base main --head HEAD \
  --experiments /path/to/proofably/examples/experiments.json \
  --output proofably-report.json
```

`--experiments` contains JSON such as:

```json
{ "experiments": [{ "id": "test-suite", "command": ["node", "--test"] }] }
```

Commands are executed within a `node:22-alpine` image. The source is a Git archive, not a host workspace mount. The image is not currently pinned by digest. This starter supports projects that need no additional dependency installation. It is **not suitable for running hostile repositories**: Docker isolation alone is not a hardened boundary and build/test scripts can be malicious. Use disposable machines for untrusted inputs.

## Evidence semantics

- `no-difference`: normalized exit status and output match; does **not** prove correctness.
- `behavioral-difference`: outputs differ; does **not** establish a bug.
- `unverified`: a run could not complete.

## Roadmap

1. Build a reproducible defect benchmark and conventional LLM-review baseline.
2. Add independent requirement/contract extraction with provenance.
3. Add an LLM experiment planner behind a provider interface.
4. Support generated test harnesses and stronger evidence validation.
5. Introduce stronger sandboxing, dependency setup, and resource accounting.

## License

Apache-2.0

## Function verification experiments

A separate, versioned function-experiment API now validates explicit targets,
JSON arguments, contract provenance, and intended execution metadata. Its first
deterministic predicate checks the smallest power of two greater than or equal
to a positive safe integer. Behavioral comparison and per-revision contract
verdicts remain separate. See [the schema and verdict limits](docs/verification-experiments.md).
Function experiments can now run through a separate Docker execution entry point;
see [local execution and integration tests](docs/verification-experiments.md#docker-execution-task-2).
Function verification defaults to three fresh Docker attempts per revision and
writes a versioned evidence bundle. Replay reruns the saved experiment with exact
recorded commits, image, and installed artifacts:

```sh
node src/function-cli.js replay --bundle function-report.json \
  --repository /path/to/target-repository --output replay-report.json
```

See [repetition, evidence, and replay](docs/verification-experiments.md#repetition-and-evidence-checkpoint-3)
for settings, classifications, and limits. There is no AI planner yet.
