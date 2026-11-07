# Parkwright — agent notes

- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current.
- Original game: no names, art, code or levels from any existing park game. OpenRCT2 is GPL; learn mechanics, never copy code.
- packages/sim is deterministic: no Math.random, no Date.now, no DOM. All randomness via state.rng. Replay must reproduce the state hash.
- The LLM never decides accept/reject or moves money; actions' query() does.
- Testnet only. Keys live in .env, never in the repo. Reuse the NEAR AI key from the Bazaar of Liars .env.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits (one logical change each).
- Workflow: never commit to main. Each change on its own branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`, `ci/…`), PR, code review, then `gh pr merge --rebase --delete-branch`. Pull main and delete the local branch afterwards. No AI attribution in PR bodies.
