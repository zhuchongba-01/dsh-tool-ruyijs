Run a site's own JavaScript in a real Firefox engine: SpiderMonkey evaluates, Necko fetches, there is no renderer and no window. Three DSH tools — `ruyijs_run` opens a page and runs the script that signs the request, `ruyijs_net` reads that context's request and console records, `ruyijs_close` drops a context by origin.

**Reach for it** when the body only appears after the site's own scripts run, when a bot check has to be passed, when the site inspects the TLS fingerprint, or when a signed request chain has to be reproduced. Plain pages and bare APIs belong to `web_fetch`; do not spawn a process for them.

**Skip it** for screenshots, clicks, layout measurement, or viewport decisions — there is no layout engine, so element positions mean nothing. Those go to chromium headless shell (recipe in the README).

One context is four processes and about 155MB resident. That is ruyijs' normal shape, not a leak. It starts on first use, recycles itself after `idleSeconds` of inactivity, and answers `no live ruyijs context` once recycled — pass the `url` again to reopen.

Installation, the full parameter table, troubleshooting, and uninstall live in the repository README and SETUP.md.
