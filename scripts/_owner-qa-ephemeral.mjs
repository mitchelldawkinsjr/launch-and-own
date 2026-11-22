// Ephemeral owner-account live QA driver for Issue #21. Not committed.
import {chromium} from "playwright-core";
import {createHash} from "node:crypto";
import {writeFileSync} from "node:fs";

const ORIGIN = "https://onboard.360web.cloud";
const SITE = {
  name: "QA Willow Owner Rehearsal",
  tagline: "Moments kept with care — owner QA rehearsal",
  about: "Temporary owner-account acceptance site for Launch & Own Issue #21. Fictional photography studio used only to verify preview, approval and exact live revision.",
  services: "Family portraits\nCommunity events\nPhoto editing",
  theme: "forest",
  contactEmail: "qa-owner-rehearsal@example.com"
};
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function waitForSetup(page, timeoutMs = 12 * 60 * 1000) {
  const started = Date.now();
  let clickedGitHub = false;
  let clickedCloudflare = false;
  while (Date.now() - started < timeoutMs) {
    const url = page.url();
    const html = await page.content();
    if (html.includes("Generate website preview") && html.includes("Account selected")) {
      console.log("Setup ready.");
      return "ready";
    }
    if (html.includes("Choose your Cloudflare account")) {
      console.log("Selecting first Cloudflare account…");
      await page.locator('select[name="accountId"]').selectOption({index: 0});
      await Promise.all([
        page.waitForNavigation({waitUntil: "domcontentloaded"}),
        page.locator('form[action="/account"] button').click()
      ]);
      continue;
    }
    // Provider consent pages: leave alone for the human to finish.
    if (/github\.com|cloudflare\.com/.test(url)) {
      console.log("Complete provider consent in the Chrome window, then return to onboard… (" + url.split("?")[0] + ")");
      await page.waitForTimeout(3000);
      continue;
    }
    if (html.includes("Connect Cloudflare") && !html.includes("Generate website preview")) {
      if (!clickedCloudflare) {
        console.log("Clicking Connect Cloudflare…");
        clickedCloudflare = true;
        await Promise.all([
          page.waitForNavigation({waitUntil: "domcontentloaded", timeout: 60000}).catch(() => {}),
          page.locator('a[href="/connect/cloudflare"]').click()
        ]);
        continue;
      }
      console.log("Waiting for Cloudflare consent to finish…");
    } else if (html.includes("Connect GitHub")) {
      if (!clickedGitHub) {
        console.log("Clicking Connect GitHub…");
        clickedGitHub = true;
        await Promise.all([
          page.waitForNavigation({waitUntil: "domcontentloaded", timeout: 60000}).catch(() => {}),
          page.locator('a[href="/connect/github"]').click()
        ]);
        continue;
      }
      console.log("Waiting for GitHub consent to finish…");
    } else {
      console.log("Waiting for setup form…");
    }
    await page.waitForTimeout(3000);
    if (!page.url().startsWith(ORIGIN) && !/github\.com|cloudflare\.com/.test(page.url())) {
      await page.goto(ORIGIN + "/", {waitUntil: "domcontentloaded"});
    }
  }
  throw new Error("Timed out waiting for GitHub+Cloudflare+account setup");
}

async function main() {
  console.log("Opening Chrome for owner QA. Complete GitHub and Cloudflare sign-in in that window if prompted.");
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.bringToFront();
  await page.goto(ORIGIN + "/", {waitUntil: "domcontentloaded"});
  console.log(">>> ACTION NEEDED: in the Chrome window, approve GitHub then Cloudflare when prompted.");
  await waitForSetup(page);

  await page.locator('input[name="name"]').fill(SITE.name);
  await page.locator('input[name="tagline"]').fill(SITE.tagline);
  await page.locator('textarea[name="about"]').fill(SITE.about);
  await page.locator('textarea[name="services"]').fill(SITE.services);
  await page.locator('select[name="theme"]').selectOption(SITE.theme);
  await page.locator('input[name="contactEmail"]').fill(SITE.contactEmail);

  await Promise.all([
    page.waitForNavigation({waitUntil: "domcontentloaded"}),
    page.locator('form[action="/preview"] button').click()
  ]);

  const reviewUrl = page.url();
  if (!reviewUrl.includes("/review")) throw new Error("Expected /review after preview, got " + reviewUrl);

  const previewHref = await page.locator('a[href*="/site-preview"]').getAttribute("href");
  if (!previewHref) throw new Error("Missing site-preview link");
  const previewUrl = new URL(previewHref, ORIGIN).href;
  const previewResponse = await page.request.get(previewUrl);
  if (!previewResponse.ok()) throw new Error("site-preview HTTP " + previewResponse.status());
  const previewHtml = await previewResponse.text();
  const approvedHtmlSha256 = sha256(previewHtml);
  if (!previewHtml.includes(SITE.tagline)) throw new Error("Preview missing expected headline");

  const digest = await page.locator('form[action="/approve"] input[name="digest"]').inputValue();
  console.log("Approving launch; digest length=", digest.length);

  await Promise.all([
    page.waitForNavigation({waitUntil: "domcontentloaded"}),
    page.locator('form[action="/approve"] button').click()
  ]);

  let status = "unknown";
  let websiteUrl = null;
  let expectedCommit = null;
  for (let i = 0; i < 60; i++) {
    const body = await page.content();
    const statusMatch = body.match(/Status:\s*([^<]+)/);
    status = statusMatch ? statusMatch[1].trim() : status;
    console.log(`poll ${i + 1}: status=${status} url=${page.url()}`);

    if (body.includes("Approve and create website")) {
      // still preview somehow
    }
    if (await page.locator('form[action="/launch"] button').count()) {
      await Promise.all([
        page.waitForNavigation({waitUntil: "domcontentloaded"}),
        page.locator('form[action="/launch"] button').click()
      ]);
      continue;
    }
    if (await page.locator('form[action="/verify"] button').count()) {
      await Promise.all([
        page.waitForNavigation({waitUntil: "domcontentloaded"}),
        page.locator('form[action="/verify"] button').click()
      ]);
      continue;
    }

    const link = page.locator('a[href*="pages.dev"], a[href*="http"]').filter({hasText: /http/i});
    if (await link.count()) {
      websiteUrl = await link.first().getAttribute("href");
    }
    const shaMatch = body.match(/\b([a-f0-9]{40})\b/);
    if (shaMatch) expectedCommit = shaMatch[1];

    if (/live/i.test(status) || (websiteUrl && /live/i.test(body))) {
      break;
    }
    if (/failed|error|paused|needs_reauthorization/i.test(status + body)) {
      writeFileSync("/tmp/lao-owner-qa-fail.html", body);
      throw new Error("Launch entered failure/paused state: " + status);
    }
    await page.waitForTimeout(5000);
    await page.reload({waitUntil: "domcontentloaded"});
  }

  let liveHtmlSha256 = null;
  let liveStatus = null;
  if (websiteUrl) {
    const live = await fetch(websiteUrl.endsWith("/") ? websiteUrl : websiteUrl + "/", {
      redirect: "manual",
      signal: AbortSignal.timeout(20000)
    });
    liveStatus = live.status;
    if (live.ok) {
      const liveHtml = await live.text();
      liveHtmlSha256 = sha256(liveHtml);
    }
  }

  const evidence = {
    issue: 21,
    mode: "owner-account-live-rehearsal",
    origin: ORIGIN,
    siteName: SITE.name,
    reviewUrl,
    approvedHtmlSha256,
    digestPrefix: digest.slice(0, 12),
    expectedCommitSha: expectedCommit,
    websiteUrl,
    liveHttpStatus: liveStatus,
    liveHtmlSha256,
    htmlMatchesApproved: liveHtmlSha256 === approvedHtmlSha256,
    finalUiStatus: status,
    completedAt: new Date().toISOString()
  };
  writeFileSync("/tmp/lao-owner-qa-evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  await browser.close();
  if (!evidence.htmlMatchesApproved || !evidence.websiteUrl) process.exitCode = 2;
}

main().catch((error) => {
  console.error("OWNER_QA_FAILED:", error.message);
  process.exitCode = 1;
});
