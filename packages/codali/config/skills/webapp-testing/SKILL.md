---
name: webapp-testing
description: "Verify a local web UI with observed page state and browser interactions; distinguish static previews from backend services."
---

Read the application entry point and package scripts before choosing a launch method. For a static site, browser_session provides a persistent read-only preview. In its browser the workspace is served at http://127.0.0.1:8000/. The returned previewUrl is the host URL for SSH forwarding; it uses a different port.

For a backend, use its existing managed service or an authorized host service workflow. A temporary run_shell server can support checks within that single call, but cannot provide a persistent demo URL.

Browser journey of an app with a backend: do not write a browser driver. Read this skill's journey-driver.mjs with skill_read (path journey-driver.mjs, follow nextOffset to the end) and save it unchanged in the project's test folder. It needs Node 22 and an installed Chrome or Chromium, and no packages. Then write one short script that does everything in a single run_shell call, because processes do not survive the call:

    import { launch, startServer } from './journey-driver.mjs';
    const server = await startServer('node', ['server/index.js'], { url: 'http://127.0.0.1:3000/health', env: { PORT: '3000' } });
    const page = await launch();
    try {
      await page.goto('http://127.0.0.1:3000/');
      await page.type('#email', 'admin@example.test'); await page.type('#password', 'correct horse');
      await page.click('button[type=submit]'); await page.waitForText('Dashboard');
    } finally { await page.close(); server.kill(); }

The page object has goto, click, type, text, waitForSelector, waitForText, waitFor (any expression), evaluate and screenshot. A wait that fails reports what the page shows instead. Print PASS or FAIL per scenario and exit non-zero on a failure. Run it with run_shell and timeoutSeconds sized to the journey (for example 300). Use data-testid or id selectors you put in the markup yourself.

Inspect rendered page state before selecting controls. Exercise the requested user journey, verify visible outcomes, and run the project's real tests separately. A successful HTTP fetch does not prove interactivity. Record the tested URL and observed results; identify untested behavior.

Source: https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md. Original Codali adaptation of its inspect-before-action workflow; no upstream scripts bundled.
