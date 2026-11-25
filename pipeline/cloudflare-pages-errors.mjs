import { readBounded } from './bounded-body.mjs';
import { ProviderRequestError } from './provider-errors.mjs';

export async function readPagesJson(response) {
  try {
    const bytes = await readBounded(response.body, 64 * 1024);
    return bytes?.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
  } catch {
    return null;
  }
}

export async function pagesRequestError(response, options, parsed) {
  const error = new ProviderRequestError(response, options);
  const data = parsed === undefined ? await readPagesJson(response) : parsed;
  const code = Array.isArray(data?.errors) ? data.errors[0]?.code : null;
  const providerCode = Number.isSafeInteger(code) && code >= 0 && code <= 999999999 ? String(code) : '';
  const ray = response.headers.get('cf-ray') || '';
  // Support correlation data only. Never include URLs, account IDs, credentials or provider messages.
  console.error(JSON.stringify({
    event: 'cloudflare_pages_request_denied', httpStatus: response.status,
    providerCode: providerCode || null, rayId: /^[a-f\d]{12,32}(?:-[a-z]{3})?$/i.test(ray) ? ray : null
  }));
  error.code = 'cloudflare_pages_http_' + response.status + (providerCode ? '_cf' + providerCode : '');
  return error;
}
