For bodies that only appear once the site's own scripts run, for bot checks, and for sites that inspect the TLS fingerprint; plain pages and bare APIs go to `web_fetch` — do not spawn a process for them.

No layout engine: screenshots, clicks, and layout go to chromium headless shell.

Four processes and about 155MB per context is normal, not a leak; it recycles after `idleSeconds`. Parameters and troubleshooting in the README.
