// Classify transport failures without retaining provider bodies, URLs or credentials.
export class ProviderRequestError extends Error {
  constructor(response, { conflictCanRetry = false } = {}) {
    super('Provider request failed');
    this.status = response?.status;
    const retryAfter = response?.headers.get('retry-after');
    const seconds = retryAfter && /^\d+$/.test(retryAfter)
      ? Number(retryAfter)
      : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
    this.retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const rateLimited = this.status === 429 || (this.status === 403 &&
      (retryAfter || response.headers.get('x-ratelimit-remaining') === '0'));
    this.retryable = !response || rateLimited || this.status === 408 || this.status >= 500 ||
      (conflictCanRetry && (this.status === 409 || this.status === 422));
    this.authorizationLost = this.status === 401 || (this.status === 403 && !rateLimited);
  }
}
