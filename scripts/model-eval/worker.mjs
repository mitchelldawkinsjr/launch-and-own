// Manual model accuracy Worker for `wrangler dev --remote` only. Never deploy it.
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only', {status: 405});
    const {model, messages} = await request.json();
    const allowed = ['@cf/ibm-granite/granite-4.0-h-micro', '@cf/zai-org/glm-4.7-flash', '@cf/openai/gpt-oss-20b'];
    if (!allowed.includes(model)) return new Response('model not allowed', {status: 400});
    try {
      const out = await env.AI.run(model, {messages, max_tokens: 2500, temperature: 0});
      return Response.json(out);
    } catch (error) { return Response.json({error: String(error?.message || error)}, {status: 502}); }
  }
};
