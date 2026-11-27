# Using taste-skill on Launch & Own

Installed from https://github.com/Leonxlnx/taste-skill (`design-taste-frontend`).

## Hard limits for this repo

Worker marketing/onboarding CSP is:

`default-src 'none'; style-src 'unsafe-inline'; ...`

So a taste pass here must:

- keep CSS inline (no Google Fonts CDN, no remote stylesheets)
- use no `<img>`, remote icons, shaders, or scripts on Worker-rendered pages
- keep product UI mocks as CSS/HTML, not photographs
- leave `#164` `marketing-pipeline.mjs` / `ai-update-journey.mjs` contracts intact unless that owner is in the change

## Good fit

Signed-out marketing landing (`onboarding/landing.mjs`): section rhythm, hero entrance, hover micro-motion, plain copy, product UI mock.

## Poor fit without CSP work

Full taste deal (Geist fonts, photo library, WebGL moments, consistency gate over HTTP assets).
