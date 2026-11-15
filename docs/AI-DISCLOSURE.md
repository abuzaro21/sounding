# AI disclosure

## How SOUNDING was built

- **Code, tests, docs and the film pipeline** were written by Claude Opus 5.5 (`claude-opus-5-5`), running in Claude Code under the owner's direction and permission settings.
- **Independent review** was done by OpenAI Codex CLI with model `gpt-6.1-sol`, always in a read-only sandbox. It never wrote to the repository. The run headers record the model, the sandbox mode and the session id. Curated prompts and outputs are in [reviews/](reviews/). Every finding was checked against the code before it was fixed, and each review file says which fixes came after that review.
- **Narration** for the film was synthesised locally with Kokoro, an open-weight text-to-speech model. Captions come from the same script.
- **Human review.** The owner set the brief and the constraints. Unless [SUBMISSION](SUBMISSION.md) records otherwise, nobody has yet watched and listened to the film end to end.

## What runs in the product

**No language model runs at run time.** The "agent" (`src/agent.ts`, `agent:planner-v1`) is deterministic code. It compiles a plain-language request into one of two allowlisted templates, states what it expects (only its target table, as an agent writing `DELETE … WHERE` would), and after a blocked simulation it narrows the scope from the evidence the simulation measured. It can propose. It cannot approve or execute.

Choosing a deterministic agent was deliberate:

- the demo costs nothing to run and needs no API key;
- every visitor sees the same behaviour, so the eval numbers are reproducible;
- the point of SOUNDING is the gate, which must hold **whatever** proposes the action. A language-model planner would sit in the same place, upstream of the same simulation, policy, approval and verifier.

## Data

All business records are synthetic, generated from a seed. No real personal data was used in development, tests, the eval, the film or the live demo. No model was trained or tuned on anything here.
