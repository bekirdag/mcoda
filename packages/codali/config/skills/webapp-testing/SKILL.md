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
    let failed = false;
    const step = (name, run, options) => page.step(name, run, options).catch(() => { failed = true; });
    try {
      await step('admin signs in', async () => {
        await page.goto('http://127.0.0.1:3000/');
        await page.type('#email', 'admin@example.test'); await page.type('#password', 'correct horse');
        await page.click('button[type=submit]'); await page.waitForText('Dashboard');
      }, { allow: [/^401 GET \S+\/api\/me$/] }); // the signed-out session probe is expected
      await step('after a reload, admin still creates a project', async () => {
        await page.reload(); await page.waitForText('Dashboard');
        await page.type('#project-name', 'Apollo'); await page.click('#create-project'); await page.waitForText('Apollo');
        await page.reload(); await page.waitForText('Apollo'); // the server kept it
      });
    } finally { await page.close(); server.kill(); }
    process.exit(failed ? 1 : 0);

The page object has goto, reload, step, click, type, text, waitForSelector, waitForText, waitFor (any expression), evaluate, screenshot, unlabelledControls and problems. A wait that fails reports what the page shows instead. page.step(name, run, { allow }) prints PASS or FAIL for one scenario step. It fails the step on any console error, uncaught exception, failed request or 4xx/5xx response during it, naming the request, and on any visible input, select or textarea without an accessible name (label for, wrapping label, aria-label or aria-labelledby). Put every scenario in a step. List in allow only a response the step expects, such as a refusal the requirements demand, by status or by a RegExp matched against "STATUS METHOD URL". Exit non-zero on a failure. Run it with run_shell and timeoutSeconds sized to the journey (for example 300). Use data-testid or id selectors you put in the markup yourself.

Every role's journey includes at least one step that reloads a signed-in page and then performs a mutation through the UI. A fresh sign-in before each step never tests the session restore, and an API read does not replace the reload. When the requirements say an action is unavailable, blocked or disabled and explained, assert in the journey that the control or notice is visible, that the control is disabled or refuses, and that the stated reason text appears; a missing control fails that assertion.

Inspect rendered page state before selecting controls. Exercise the requested user journey, verify visible outcomes, and run the project's real tests separately. A successful HTTP fetch does not prove interactivity. Record the tested URL and observed results; identify untested behavior.

Source: https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md. Original Codali adaptation of its inspect-before-action workflow; no upstream scripts bundled.
