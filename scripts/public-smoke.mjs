// Read-only public checks for https://onboard.360web.cloud. No cookies, tokens, or OAuth state are printed.
const ORIGIN = "https://onboard.360web.cloud";
const GITHUB_CLIENT_ID = "Iv23li8rVTNtZrfTctqJ";
const GITHUB_CALLBACK = ORIGIN + "/oauth/github/callback";
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const PAGES = [
  ["/", "Launch your website | Launch & Own", "Your website."],
  ["/privacy", "Privacy Policy | Launch & Own", "Privacy Policy"],
  ["/terms", "Terms of Service | Launch & Own", "Terms of Service"]
];

function fail(route, expected, actual) {
  return {route, expected, actual};
}

async function read(fetchFn, path, redirect) {
  const response = await fetchFn(ORIGIN + path, {redirect, headers:{accept:"text/html,application/json"}});
  const body = await response.text();
  return {response, body};
}

export async function smokePublic({fetchFn = fetch} = {}) {
  const failures = [];
  const health = await read(fetchFn, "/health", "error");
  let healthBody = null;
  try { healthBody = JSON.parse(health.body); } catch { healthBody = null; }
  if (health.response.status !== 200 || healthBody?.ok !== true || healthBody?.configured !== true || healthBody?.launchJobsReady !== true)
    failures.push(fail("/health", "200 {ok,configured,launchJobsReady:true}", health.response.status + " " + health.body.slice(0, 120)));
  if (health.response.headers.get("cache-control") !== "no-store")
    failures.push(fail("/health", "cache-control no-store", health.response.headers.get("cache-control")));

  for (const [path, title, marker] of PAGES) {
    const page = await read(fetchFn, path, "error");
    if (page.response.status !== 200 || !page.body.includes("<title>" + title + "</title>") || !page.body.includes(marker))
      failures.push(fail(path, "200 " + title, String(page.response.status)));
    checkHtml(failures, path, page.response);
  }

  const missing = await read(fetchFn, "/no-such-qa-path", "error");
  if (missing.response.status !== 404 || !missing.body.includes("<title>Setup could not continue | Launch & Own</title>"))
    failures.push(fail("/no-such-qa-path", "404 Setup could not continue", String(missing.response.status)));
  checkHtml(failures, "/no-such-qa-path", missing.response);

  const github = await read(fetchFn, "/connect/github", "manual");
  const location = github.response.headers.get("location") || "";
  let target = null;
  try { target = new URL(location); } catch { target = null; }
  const githubOk = github.response.status === 303 && target?.origin === "https://github.com" &&
    target.pathname === "/login/oauth/authorize" && target.searchParams.get("client_id") === GITHUB_CLIENT_ID &&
    target.searchParams.get("redirect_uri") === GITHUB_CALLBACK && target.searchParams.get("code_challenge_method") === "S256" &&
    target.searchParams.has("state") && target.searchParams.has("code_challenge");
  if (!githubOk)
    failures.push(fail("/connect/github", "303 to GitHub authorize with the registered client and callback", String(github.response.status) + " host=" + (target?.host || "none")));
  if (github.response.headers.get("cache-control") !== "no-store")
    failures.push(fail("/connect/github", "cache-control no-store", github.response.headers.get("cache-control")));

  const cloudflare = await read(fetchFn, "/connect/cloudflare", "error");
  if (cloudflare.response.status !== 401 || !cloudflare.body.includes("Connect GitHub before connecting Cloudflare."))
    failures.push(fail("/connect/cloudflare", "401 Connect GitHub before connecting Cloudflare.", String(cloudflare.response.status)));
  checkHtml(failures, "/connect/cloudflare", cloudflare.response);

  return {ok: failures.length === 0, origin: ORIGIN, failures};
}

function checkHtml(failures, path, response) {
  if (response.headers.get("content-security-policy") !== HTML_CSP)
    failures.push(fail(path, "onboarding CSP", response.headers.get("content-security-policy") || "missing"));
  if ((response.headers.get("x-frame-options") || "").toUpperCase() !== "DENY")
    failures.push(fail(path, "x-frame-options DENY", response.headers.get("x-frame-options") || "missing"));
  if (response.headers.get("cache-control") !== "no-store")
    failures.push(fail(path, "cache-control no-store", response.headers.get("cache-control")));
}

if (process.argv[1] && process.argv[1].endsWith("public-smoke.mjs")) {
  const result = await smokePublic();
  const stamp = new Date().toISOString();
  if (!result.ok) {
    console.error(JSON.stringify({time: stamp, origin: result.origin, failures: result.failures}));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({time: stamp, origin: result.origin, ok: true, routes: ["/health", "/", "/privacy", "/terms", "/no-such-qa-path", "/connect/github", "/connect/cloudflare"]}));
  }
}
