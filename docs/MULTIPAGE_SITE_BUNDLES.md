# Four-page static business site bundles

This is an opt-in backend foundation for **Home, About, Services, and Contact** pages. It preserves the existing one-page default. It is not yet a customer-facing onboarding option.

## Why this milestone

Early Launch & Own beta versions generated one `public/index.html` file. The new `site/render-site-bundle.mjs` can produce a cohesive, self-contained four-page static website from the same normalized business information, color theme, service labels and contact email. Pages are accessible by Cloudflare Pages at `/`, `/about/`, `/services/`, and `/contact/`. All internal navigation is explicit, and every page contains its own validated HTML and inline CSS.

All generated pages use the **same customer-authored factual information**, escape HTML, provide semantic navigation, a skip link, focus styling and reduced-motion support. No scripts, third-party fonts, trackers, external images, forms, invented testimonials or API credentials are included.

## Preview and exact full-bundle approval

```js
import {renderSiteBundle,siteBundleApprovalSha256} from "./site/render-site-bundle.mjs";
import {applyWebsite} from "./pipeline/provision-site.mjs";

const config={
  name:"Willow Studio",
  githubOwner:"authorized-owner",
  accountId:"<the owner's selected and verified Cloudflare account ID>",
  site:{
    layout:"multi-page",
    tagline:"Every moment matters",
    about:"A locally owned portrait and event photography business.",
    services:["Portrait photography","Community event photography"],
    theme:"forest",
    contactEmail:"hello@example.com"
  }
};

const preview=renderSiteBundle({...config.site,name:config.name});
// Show all FOUR preview.pages to the customer; no resources are created.
// Record an explicit customer approval, bound to the complete bundle.
const approvedBundleSha256=await siteBundleApprovalSha256({...config.site,name:config.name});

// Only after authenticated, CSRF-validated user approval:
const launch=await applyWebsite({...config,approvedBundleSha256},{
  githubToken:authorizedGithubToken,
  cloudflareToken:authorizedCloudflareToken
});
// Still verify Cloudflare production deploys the exact expected GitHub SHA.
```

`approvedBundleSha256` is **required** when `site.layout==="multi-page"`. Without it, or if any rendered page differs from the approved digest, the provisioner stops **before calling GitHub or Cloudflare**. This hash does not itself prove a human approved the website: the authenticated caller must verify and durably record the customer consent associated with the exact bundle digest. Site approval must never be inferred from model output.

## Provisioning and recovery safeguards

The existing guarded `applyWebsite` creates or checks the owner's exact private Launch & Own marked GitHub repository. With the multi-page option it performs a **complete read-only preflight of all four existing files before writing any**. If any file is unrelated, missing verifiable content, or differs from the approved page, it refuses to change any page. Missing pages are created only after all existing pages pass; if provisioning is interrupted, it can safely resume. GitHub branch SHA verification and exact Cloudflare Pages deployment checks remain necessary. Each created file uses a separate GitHub content commit, and the returned `headCommitSha` identifies the final expected revision.

An existing single-page website **cannot be silently converted to a different multi-page design through provisioning**; the existing homepage mismatch intentionally blocks overwrite. Future site modifications should use the reviewable GitHub PR workflow in [SAFE_WEBSITE_UPDATES.md](SAFE_WEBSITE_UPDATES.md), with owner approval and exact deployment verification.

## Not yet implemented

- **Onboarding UI:** The Worker still normalizes and previews a one-page template. A later coordinated PR must add full four-page preview selection, record the approved bundle digest, and pass it into provisioning. Codex Max is changing launch-job orchestration, so avoid overlapping edits to `onboarding/worker.mjs` until coordinated.
- Distinct customer-authored content for each page, CMS management, media/AI imagery, photo uploads, real contact forms, SEO sitemaps and custom domains.
- Real second-customer acceptance. CI tests use mocked providers and no customer resources.

This module requires **no new Cloudflare bindings, no new DNS records, no model inference and no paid services**. Existing single-page launches stay the default.
