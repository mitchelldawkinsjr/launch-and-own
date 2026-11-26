# Model accuracy check: 2026-11-26

**Owner decisions (2026-11-26):**
- Plain-language edits run only in the customer's own Cloudflare account, with no hosted inference in Launch & Own.
- Inference we run ourselves stays inside the free Workers AI allowance.

This check informs which model the customer-owned assistant template uses. It does **not** enable anything.

## Method
- **Cases:** the 8 `EVAL_CASES` in `imported/eval.mjs`. Four are allowed edits (headline, link, email, CSS color). Four must be refused (ambiguous text, minified script, unbuilt framework, hosting config).
- **Scoring:** `scoreCandidate`. Each output goes through the production parser and validator (`parseModelOutput`, `validateEdits`). The bar is 95% valid and 90% correct (`EVAL_THRESHOLDS`). The reference answers score 100/100.
- **Setup:** a scratch Worker under `wrangler dev --remote` in the owner's account, using the Workers AI binding. Nothing was deployed. Temperature was 0, with `max_tokens` 2500. The outermost `{…}` of each reply is scored, so code fences and prose around the JSON are ignored.
- **Reproduce:** see `scripts/model-eval/` (`run.mjs` with the product prompt from `buildModelRequest`).

## Results
| Prompt | Granite 4.0 H Micro | GLM 4.7 Flash | GPT-OSS 20B |
|---|---|---|---|
| Original system prompt | 25% valid / 12.5% correct | 0 / 0 (empty replies at 900 tokens) | 12.5 / 12.5 |
| Clearer rules (scratch layout, IDs inside `capabilities`) | 75 / 75 | 75 / 62.5 | **100 / 100** |
| Clearer rules, product prompt, run 1 | 75 / 75 | 87.5 / 75 | 87.5 / 75 |
| Clearer rules, product prompt, run 2 | 75 / 75 | 62.5 / 62.5 | 100 / 87.5 |

**Why the original prompt failed:**
- **Granite** understood the request but put markup in `find`, for example `<h1>Willow Studio</h1>` or `--ink: #1f4b3a;`. The validator correctly refused it (`context_not_allowed`).
- **GPT-OSS** invented keys (`publicPath`) and sent `"v":"1"` as a string.
- **GLM** spent its token budget reasoning and returned nothing.

The clearer rules (now in `buildModelRequest`) spell out the exact keys and say that `find` is only the visible text, URL, email or phone, or color value.

## Conclusion
- **No candidate meets the bar reliably.** GPT-OSS 20B is best, but ranged from 75% to 100% correct across runs. Granite is steady at 75%, missing the headline and the ambiguity refusal. GLM varies.
- **Eight cases and single runs are too few to choose a model.** Variation at temperature 0 is visible, and the 100/100 run was on the case set the prompt was tuned against.
- **Usage:** about 150k tokens in total across six runs. That is within the account's 10,000-neuron daily free allowance at the published per-token prices, but not independently metered here.

## Next steps (before an M2 model choice)
1. **Change the output shape:** the server lists numbered editable regions (visible text, links, contact details, color properties). The model returns region numbers and new values, and the server fills in `find`, `path` and `expectedBlobSha`. This removes the formatting failures seen above, and a model can no longer invent paths.
2. **Grow the cases to at least 30**, drawn from the real-export fixtures (#169, `fixtures/imported-sites`). Run each model at least 3 times and judge by the **worst** run.
3. Re-run inside the M2 test account (customer-owned inference) once that account is authorized.

## Round 2: stronger free-tier models (2026-11-26, owner-requested)

**Method:** the same 8 `EVAL_CASES`, the same product prompt (`buildModelRequest` with the clearer rules), and the same scratch Worker under `wrangler dev --remote` in the owner's account. Nothing was deployed, and the scratch config now has `workers_dev: false`. Models were taken from the 2026-11-18 Workers AI pricing page, excluding paid-billing models (Kimi, GLM-5.x, DeepSeek V4) and checking each against the account's live catalog. `qwen3-30b-a3b` is priced but missing from the catalog, so `llama-4-scout` replaced it. Run with `EVAL_MODELS=… node scripts/model-eval/run.mjs`.

| Model | Run 1 valid / correct | Runs 2–3 | Tokens per run | Neurons per M (in / out) |
| --- | --- | --- | --- | --- |
| **@cf/openai/gpt-oss-120b** | **100 / 100** | **100 / 100, 100 / 100** | ~7.2k | 31,818 / 68,182 |
| **@cf/google/gemma-4-26b-a4b-it** | **100 / 100** | **100 / 100, 100 / 100** | ~9.2k | 9,091 / 27,273 |
| @cf/qwen/qwen2.5-coder-32b-instruct | 87.5 / 87.5 (missed `ambiguous-headline`) | not repeated | ~6.0k | 60,000 / 90,909 |
| @cf/mistralai/mistral-small-3.1-24b-instruct | 87.5 / 87.5 (missed `ambiguous-headline`) | not repeated | ~6.5k | 31,876 / 50,488 |
| @cf/meta/llama-4-scout-17b-16e-instruct | 87.5 / 87.5 (missed `ambiguous-headline`) | not repeated | ~5.4k | 24,545 / 77,273 |

All of round 2 used roughly 2,000 Neurons, inside the free 10,000/day.

**Decision:** `@cf/openai/gpt-oss-120b` is the assistant's default (`DEFAULT_AI_MODEL`), and `@cf/google/gemma-4-26b-a4b-it` is the cheaper fallback. The two tie on accuracy. The larger model leaves more margin for edits outside this small set. Cost isn't the deciding factor: about 30 Neurons per edit for gpt-oss-120b (~13 for gemma) means roughly 300 AI edits a day on the free allowance. Both meet #171 item 5's bar (95% valid, 90% correct) on this set.

**Caveat:** 8 cases are few, and the prompt was tuned against these same cases in round 1. Every model edit still passes `validateEdits` and owner approval. Growing the set to ~20 fixture cases (Worker C's drafts on #166) and re-running is the next step before relying on the score alone.
