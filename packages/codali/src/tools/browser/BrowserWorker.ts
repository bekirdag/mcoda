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
    let httpStatus: number | null = null;
    let contentType: string | null = null;
    tab.on("response", response => {
      if (response.request().isNavigationRequest() && response.frame() === tab.mainFrame()) {
        httpStatus = response.status();
        contentType = response.headers()["content-type"] ?? null;
      }
    });
    context.on("page", popup => { if (popup !== tab) void popup.close().catch(() => undefined); });
    tab.on("dialog", dialog => { void dialog.dismiss().catch(() => undefined); });
    const { BrowserSession } = await import("browser-use/dist/browser/session.js");
    session = new BrowserSession({ browser, browser_context: context, page: tab,
      profile: { accept_downloads: false, enable_default_extensions: false, captcha_solver: false,
        keep_alive: false, permissions: [], minimum_wait_page_load_time: 0,
        wait_for_network_idle_page_load_time: 0.1, maximum_wait_page_load_time: 1 } });
    // A network-interface change aborts navigation immediately and says nothing
    // about the page itself, so a single retry is cheap and cannot mask a 404.
    for (let attempt = 0; ; attempt++) {
      try { await session.navigate_to(input.url, { wait_until: "domcontentloaded", timeout_ms: 25000 }); break; }
      catch (error) {
        if (attempt >= 1 || !String(error).includes("ERR_NETWORK_CHANGED")) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    // Accessibility snapshots otherwise flatten deleted/struck-through text
    // into apparently current prose. Mark revisions in this disposable DOM;
    // no page action, form submission or remote mutation is performed.
    await tab.locator('del, s, strike, [style*="line-through"]').evaluateAll(elements => {
      for (const element of elements.slice(0, 100)) {
        if (element.parentElement?.closest('del, s, strike, [style*="line-through"]')) continue;
        element.prepend(document.createTextNode("[DELETED/STRUCK-THROUGH TEXT — not current guidance: "));
        element.append(document.createTextNode("]"));
      }
    });
    const main = tab.getByRole("main");
    const useMain = input.scope !== "page" && await main.count() > 0;
    const root = useMain ? main.first() : tab.locator("body");
    let content: string;
    let format = "accessibility";
    if (input.scope !== "page") {
      // Inline links/emphasis split ordinary prose into many ARIA records. Read
      // rendered text for research, retaining heading scopes and revision marks.
      // The disposable page is never submitted or persisted remotely.
      const links = await root.locator("a[href]").evaluateAll(elements => elements.slice(0, 128).flatMap(element => {
        const link = element as HTMLAnchorElement;
        if (link.closest('nav,[role="navigation"]') || !link.getClientRects().length) return [];
        try {
          const url = new URL(link.href);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            ? [`- link ${JSON.stringify((link.innerText || link.textContent || "").trim().slice(0, 160))}\n  - /url: ${url.href.slice(0, 1000)}`] : [];
        } catch { return []; }
      }));
      await root.locator('h1,h2,h3,h4,h5,h6,[role="heading"]').evaluateAll(elements => {
        for (const element of elements) {
          const heading = element as HTMLElement;
          const level = Number(heading.getAttribute("aria-level") || heading.tagName.slice(1)) || 2;
          const label = heading.innerText?.trim();
          if (label) heading.textContent = `- heading ${JSON.stringify(label)} [level=${Math.min(6, Math.max(1, level))}]`;
        }
      });
      content = await root.innerText({ timeout: 5000 });
      if (content.trim()) {
        format = "rendered_text";
        if (links.length) content += `\n\nSource links (first 128, bounded; not additional retrieved evidence):\n${links.join("\n").slice(0, 16000)}`;
      } else content = await root.ariaSnapshot({ timeout: 5000 });
    } else content = await tab.ariaSnapshot({ mode: "default", depth: 20, timeout: 5000 });
    reply = { ok: true, value: { url: tab.url(), httpStatus, contentType, title: (await tab.title()).slice(0, 1000), scope: useMain ? "main" : "page",
      format, content: content.slice(0, 1000000), truncated: content.length > 1000000 } };
  } catch (error) { reply = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  finally {
    await session?.stop().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
  if (process.connected) process.send?.(reply, () => process.disconnect());
});
