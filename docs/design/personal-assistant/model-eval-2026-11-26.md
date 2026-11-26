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
