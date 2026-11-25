import test from "node:test";
import assert from "node:assert/strict";
import {smokePublic} from "./public-smoke.mjs";

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(status, body, headers = {}) {
  return new Response(body, {status, headers:{
    "content-security-policy": HTML_CSP,
    "x-frame-options": "DENY",
    "cache-control": "no-store",
    ...headers
  }});
}

test("public smoke accepts the live onboarding contract and hides OAuth state", async () => {
  const seen = [];
  const fetchFn = async (url, options) => {
    seen.push(options.redirect);
    const path = new URL(url).pathname;
    if (path === "/health") return page(200, JSON.stringify({ok:true, configured:true, launchJobsReady:true}), {"content-security-policy": undefined});
    if (path === "/") return page(200, "<title>Launch your website | Launch & Own</title><h1>Your website.</h1>");
    if (path === "/privacy") return page(200, "<title>Privacy Policy | Launch & Own</title>Privacy Policy");
    if (path === "/terms") return page(200, "<title>Terms of Service | Launch & Own</title>Terms of Service");
    if (path === "/no-such-qa-path") return page(404, "<title>Setup could not continue | Launch & Own</title>");
    if (path === "/connect/github") return page(303, "", {location:"https://github.com/login/oauth/authorize?client_id=Iv23li8rVTNtZrfTctqJ&redirect_uri=https%3A%2F%2Fonboard.360web.cloud%2Foauth%2Fgithub%2Fcallback&state=secret-state&code_challenge=secret-challenge&code_challenge_method=S256"});
    if (path === "/connect/cloudflare") return page(401, "Connect GitHub before connecting Cloudflare.");
    return page(500, "unexpected");
  };
  const result = await smokePublic({fetchFn});
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(seen.includes("manual"), true);
  assert.equal(JSON.stringify(result).includes("secret-state"), false);
});

test("public smoke fails closed on a wrong status without echoing the provider URL", async () => {
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/health") return page(503, "{}", {"content-security-policy": undefined});
    if (path === "/connect/github") return page(302, "", {location:"https://evil.example/oauth?state=secret-state"});
    return page(200, "<title>Wrong | Launch & Own</title>");
  };
  const result = await smokePublic({fetchFn});
  assert.equal(result.ok, false);
  assert.equal(result.failures.some(item => item.route === "/health"), true);
  assert.equal(result.failures.some(item => item.route === "/connect/github" && !String(item.actual).includes("secret-state")), true);
  assert.equal(JSON.stringify(result).includes("secret-state"), false);
});
