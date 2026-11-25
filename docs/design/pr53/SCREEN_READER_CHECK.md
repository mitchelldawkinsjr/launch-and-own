# PR #53 screen-reader check (about 10 minutes)

Automated checks pass (contrast, headings, landmarks, labels, focus, accessibility tree). This manual pass confirms what a person actually hears. Use a local or preview build, never production.

## Setup
- macOS: Safari or Chrome, turn on VoiceOver with **Cmd+F5**. VO = Control+Option.
- Windows alternative: NVDA + Chrome or Firefox.
- Local build (Node 22.5+): `node scripts/serve-onboarding-mock.mjs --zip`, then open http://localhost:8787/. It runs the real onboarding Worker with fake GitHub and Cloudflare accounts. Consent screens are skipped, and it never contacts real providers. Drop `--zip` to see the ZIP-off landing.
- To check an exact release commit, check it out separately and add `--repo <that checkout>`.
- To reach setup, toolkit and history, use **Connect GitHub**, then **Connect Cloudflare**, then choose the test Cloudflare account on the setup page.

## Steps and what you should hear

| # | Do | Expect |
| --- | --- | --- |
| 1 | Load `/`, press **Tab** once | "Skip to content, link". Enter moves to the main content |
| 2 | **VO+U**, choose Landmarks | banner, Primary navigation, main, content information |
| 3 | **VO+U**, choose Headings | One level-1 heading, "Your website. Your rules.", then level 2 in this order: "Launch today. Improve any time. Grow when you are ready.", "You stay in control", "Questions, answered", "Start your launch", "Why do I need these two accounts?", "Ready when you are." |
| 4 | Tab to the explorer | "Launch: Get your business online, radio button, selected, 1 of 3", inside group "Choose what to explore". Each tab is announced **once** |
| 5 | Press **Right Arrow** twice | "Maintain: Make changes. Just ask." then "Grow: Grow beyond a website". The visible panel changes, and VO reads only the active panel's content |
| 6 | In the Maintain panel, read the two path cards | "Available with your own tools", then "Planned · not released" for the website assistant |
| 7 | Tab to a FAQ question, press **VO+Space** | Announced as collapsed then expanded; the answer is read |
| 8 | Tab to **Connect GitHub** in Start your launch | Announced as a link with its name; GitHub/Cloudflare "Why?" disclosures expand and collapse |
| 9 | Hero illustration | Skipped entirely; no "GH", "CF" or "Green Willow Studio" announcements |
| 10 | Turn on Reduce Motion (System Settings → Accessibility → Display), click "See how it works" | Jumps without a smooth scroll |

## Record the result
Post on PR #53: screen reader and browser versions, pass/fail per step, and anything confusing to hear, even if it technically passes.
