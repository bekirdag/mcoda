---
name: webapp-testing
description: "Verify a local web UI with observed page state and browser interactions; distinguish static previews from backend services."
---

Read the application entry point and package scripts before choosing a launch method. For a static site, browser_session provides a persistent read-only preview. In its browser the workspace is served at http://127.0.0.1:8000/. The returned previewUrl is the host URL for SSH forwarding; it uses a different port.

For a backend, use its existing managed service or an authorized host service workflow. A temporary run_shell server can support checks within that single call, but cannot provide a persistent demo URL.

Browser journey of an app with a backend: do not write a browser driver. Read this skill's journey-driver.mjs with skill_read (path journey-driver.mjs, follow nextOffset to the end) and save it unchanged in the project's test folder. It needs Node 22 and an installed Chrome or Chromium, and no packages. Then write one short script, following the usage example at the top of the driver, that does everything in a single run_shell call, because processes do not survive the call. Put each scenario in page.step: it prints PASS or FAIL and fails on any console error, uncaught exception, failed request or 4xx/5xx response during the step, and on unlabelled form controls; allow lists only responses the step expects. Exit non-zero on a failure. Run it with run_shell and timeoutSeconds sized to the journey (for example 300). Use id selectors you put in the markup.

Each role's journey has a step that reloads a signed-in page and then mutates through the UI; an API read never replaces the reload. For an action the requirements call unavailable and explained, assert the visible disabled control or notice and its reason text; a missing control fails.

Inspect rendered page state before selecting controls. Exercise the requested user journey, verify visible outcomes, and run the project's real tests separately. A successful HTTP fetch does not prove interactivity. Record the tested URL and observed results; identify untested behavior.

Source: https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md. Original Codali adaptation of its inspect-before-action workflow; no upstream scripts bundled.
