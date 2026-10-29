import { chromium } from "playwright-core";

// This process runs in a private empty directory with an explicit environment.
// browser-use reads .env at import time, so never import it in the CLI process.
process.once("message", async (input: { endpoint: string; url: string; scope: "main" | "page" }) => {
  let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
  let session: import("browser-use/dist/browser/session.js").BrowserSession | undefined;
  let reply: unknown;
  try {
    browser = await chromium.connect(input.endpoint, { timeout: 10000 });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", permissions: [] });
    context.setDefaultTimeout(5000);
    await context.route("**/*", route => {
      const request = route.request();
      let url: URL;
      try { url = new URL(request.url()); } catch { return route.abort("blockedbyclient"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !["GET", "HEAD"].includes(request.method())) return route.abort("blockedbyclient");
      return route.continue();
    });
    await context.routeWebSocket("**/*", socket => socket.close());
    const tab = await context.newPage();
    context.on("page", popup => { if (popup !== tab) void popup.close().catch(() => undefined); });
    tab.on("dialog", dialog => { void dialog.dismiss().catch(() => undefined); });
    const { BrowserSession } = await import("browser-use/dist/browser/session.js");
    session = new BrowserSession({ browser, browser_context: context, page: tab,
      profile: { accept_downloads: false, enable_default_extensions: false, captcha_solver: false,
        keep_alive: false, permissions: [], minimum_wait_page_load_time: 0,
        wait_for_network_idle_page_load_time: 0.1, maximum_wait_page_load_time: 1 } });
    await session.navigate_to(input.url, { wait_until: "domcontentloaded", timeout_ms: 25000 });
    const main = tab.getByRole("main");
    const useMain = input.scope !== "page" && await main.count() > 0;
    const content = useMain ? await main.first().ariaSnapshot({ timeout: 5000 }) : await tab.ariaSnapshot({ mode: "default", depth: 20, timeout: 5000 });
    reply = { ok: true, value: { url: tab.url(), title: (await tab.title()).slice(0, 1000), scope: useMain ? "main" : "page",
      content: content.slice(0, 100000), truncated: content.length > 100000 } };
  } catch (error) { reply = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  finally {
    await session?.stop().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
  if (process.connected) process.send?.(reply, () => process.disconnect());
});
