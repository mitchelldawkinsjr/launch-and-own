// Manual model accuracy Worker for `wrangler dev --remote` only. Never deploy it.
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only', {status: 405});
    const {model, messages} = await request.json();
    const allowed = ['@cf/ibm-granite/granite-4.0-h-micro', '@cf/zai-org/glm-4.7-flash', '@cf/openai/gpt-oss-20b',
      // Round 2 (2026-11-26): stronger free-tier models, no paid-billing models.
      '@cf/openai/gpt-oss-120b', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/google/gemma-4-26b-a4b-it',
      '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/meta/llama-4-scout-17b-16e-instruct'];
    if (!allowed.includes(model)) return new Response('model not allowed', {status: 400});
    try {
      const out = await env.AI.run(model, {messages, max_tokens: 2500, temperature: 0});
      return Response.json(out);
    } catch (error) { return Response.json({error: String(error?.message || error)}, {status: 502}); }
  }
};
