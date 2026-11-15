# Proofably

An experimental, agent-independent verification engine for code changes.

**Current status: experimental verification prototype.** Proofably compares Git revisions in Docker, evaluates explicit function contracts, saves reproducible evidence, and replays execution. An optional OpenAI Responses API planner proposes bounded adversarial inputs for a selected JavaScript function. Requirements and contracts are still supplied explicitly; AI does not establish defects.

## Quick start

Requirements: Node.js 22+, Docker daemon, Git. Run from the Git repository you want to verify.

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
3. Evaluate the initial provider-neutral experiment planner against real defects.
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
for settings, classifications, and limits. An optional AI planner is described below.


## AI-generated inputs (Checkpoint 4)

Install the pinned dependencies with `npm ci` (Node.js 22+). Start Docker and
install `node:22-alpine` explicitly. Supply `OPENAI_API_KEY` through the environment
only; no `.env` loader or key CLI flag is provided.

```sh
# Enter the key without putting it into shell history or printing it.
read -rs -p 'OpenAI API key: ' OPENAI_API_KEY; echo
export OPENAI_API_KEY

node src/function-cli.js ai \
  --repository /path/to/target-repository \
  --base main --head HEAD \
  --experiment tests/fixtures/power-of-two/experiment.json \
  --model gpt-6-luna --max-cases 5 --max-cost-usd 0.02 \
  --output-dir proofably-ai-example
```

This explicitly sends only the selected function's bounded base/candidate source,
its selected-function diff, and the supplied contract to OpenAI. The target must
exist in both revisions and match the experiment. Template arguments are not sent
as examples. The model generates arguments and rationale, never executable tests
or authoritative expected outputs. Only the existing power-of-two contract is
supported in this checkpoint.

The default is one request, no retries, up to five cases, and three Docker attempts
per revision per case, within a shared three-minute run budget. Cost controls are
conservative application estimates, **not guaranteed billing hard stops**.
Unknown/stale pricing fails closed. See [AI planner limits, pricing and evidence](docs/verification-experiments.md#ai-generated-experiments-checkpoint-4).

The new directory contains `planning.json`, `manifest.json`, and ordinary
`case-001.json` evidence bundles. Replay a case without OpenAI:

```sh
node src/function-cli.js replay --bundle proofably-ai-example/case-001.json \
  --repository /path/to/target-repository --output replay.json
```

`npm test` never enables the live API test by default. To explicitly run the paid
live demonstration with credentials and Docker available:

```sh
PROOFABLY_LIVE_API_TEST=1 npm run test:live
```
