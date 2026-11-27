import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../shell/IsolatedExecutor.js";
import { defaultDocumentPythonRoot } from "../documents/DocumentTools.js";

/** Navigation failures that say nothing about the page itself: the site
 * refused or dropped the automated browser, or the URL started a download.
 * In cycles 4-6 these hid official pages (court, regulator and archive sites)
 * that a plain request reads without trouble. */
export const browserRefused = (message: string): boolean =>
  /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED)|ERR_EMPTY_RESPONSE|ERR_ABORTED|ERR_TIMED_OUT|ERR_SSL_PROTOCOL_ERROR|ERR_QUIC_PROTOCOL_ERROR|Timeout \d+ms exceeded|Download is starting/.test(message);

export const isPdf = (contentType: string | null, url: string): boolean =>
  /application\/(?:x-)?pdf/i.test(contentType ?? "") || /\.pdf(?:$|[?#])/i.test(url);

export interface DirectResponse { url: string; httpStatus: number; contentType: string | null; body: Buffer; truncated: boolean }

// Official reports run large: a grid operator's final incident report was 50.8 MB.
const MAX_PDF_BYTES = 96 * 1024 * 1024;
const MAX_TEXT_BYTES = 6 * 1024 * 1024;

/** One unauthenticated GET from this process: no cookies, no credentials, no
 * scripts. The body is read up to a fixed size and treated as untrusted text. */
export async function fetchDirect(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<DirectResponse> {
  // Twenty seconds for the server to answer, then up to three minutes for a large body.
  const limiter = new AbortController();
  let timer = setTimeout(() => limiter.abort(new Error("The server did not answer within 20 seconds")), 20000);
  try {
    const response = await fetcher(url, { method: "GET", redirect: "follow", credentials: "omit", signal: signal ? AbortSignal.any([signal, limiter.signal]) : limiter.signal,
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5", "accept-language": "en-US,en;q=0.9" } });
    clearTimeout(timer); timer = setTimeout(() => limiter.abort(new Error("The download did not finish within three minutes")), 180000);
    const finalUrl = new URL(response.url || url);
    if (!["http:", "https:"].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password) throw new Error("Redirected outside http/https");
    const contentType = response.headers.get("content-type");
    const max = isPdf(contentType, finalUrl.href) ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
    const chunks: Buffer[] = []; let bytes = 0, truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (bytes + part.value.byteLength > max) { chunks.push(Buffer.from(part.value.subarray(0, max - bytes))); bytes = max; truncated = true; break; }
          chunks.push(Buffer.from(part.value)); bytes += part.value.byteLength;
        }
      } finally { await reader.cancel().catch(() => undefined); }
    }
    return { url: finalUrl.href, httpStatus: response.status, contentType, body: Buffer.concat(chunks), truncated };
  } finally { clearTimeout(timer); }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€", pound: "£", copy: "©", reg: "®", deg: "°", middot: "·", bull: "•", times: "×" };
const decodeEntities = (text: string): string => text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
  if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? whole;
  const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
});

export const decodeBody = (body: Buffer, contentType: string | null): string => {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1] ?? "utf-8";
  try { return new TextDecoder(declared).decode(body); } catch { return new TextDecoder("utf-8").decode(body); }
};

/** HTML beyond this is cut before conversion: the work below is linear, and no
 * page worth reading needs more (the browser path keeps its own larger limit). */
const MAX_HTML_CHARS = 1_500_000;

/** Remove every `<tag ...>...</tag>` block for the given tags in one pass. An
 * unclosed block is dropped to the end. Linear: each index is searched once,
 * unlike a lazy regex, which rescans from every unclosed opening tag (a
 * 400 KB page of unclosed tags held the process for 30 s). */
const stripBlocks = (html: string, tags: string[]): string => {
  const lower = html.toLowerCase();
  let out = "", at = 0;
  while (at < html.length) {
    let open = -1, tag = "";
    for (const name of tags) {
      let found = lower.indexOf(`<${name}`, at);
      // A longer tag name that merely starts the same way is not this tag.
      while (found >= 0 && /[a-z0-9-]/.test(lower[found + name.length + 1] ?? "")) found = lower.indexOf(`<${name}`, found + 1);
      if (found >= 0 && (open < 0 || found < open)) { open = found; tag = name; }
    }
    if (open < 0) { out += html.slice(at); break; }
    out += html.slice(at, open) + " ";
    const close = lower.indexOf(`</${tag}`, open);
    if (close < 0) break;
    const end = lower.indexOf(">", close);
    if (end < 0) break;
    at = end + 1;
  }
  return out;
};

/** Inner HTML of the first `<tag>` block, found with two index searches. */
const firstBlock = (html: string, tag: string): string | undefined => {
  const lower = html.toLowerCase(), open = lower.search(new RegExp(`<${tag}[\\s>]`));
  if (open < 0) return undefined;
  const start = lower.indexOf(">", open), close = lower.indexOf(`</${tag}`, open);
  return start >= 0 && close > start ? html.slice(start + 1, close) : undefined;
};

/** Readable text of an HTML document without running it: headings keep the
 * marker the snapshot reader navigates by, links are listed once at the end.
 * Every pattern here is bounded or anchored on a single character class, so
 * hostile markup costs time in proportion to its length, not its square. */
export function htmlToText(html: string, baseUrl: string, scope: "main" | "page" = "main"): { title: string; content: string; scope: "main" | "page" } {
  html = html.slice(0, MAX_HTML_CHARS);
  const title = decodeEntities(/<title[^>]{0,200}>([^<]{0,500})/i.exec(html.slice(0, 20000))?.[1] ?? "").replace(/\s+/g, " ").trim();
  let body = stripBlocks(html.replace(/<!--/g, "<codalicomment>").replace(/-->/g, "</codalicomment>"), ["codalicomment", "script", "style", "noscript", "svg", "template", "head", "iframe"]);
  let used: "main" | "page" = "page";
  if (scope === "main") {
    const main = firstBlock(body, "main") ?? firstBlock(body, "article");
    if (main && main.replace(/<[^>]*>/g, "").trim().length > 200) { body = main; used = "main"; }
    else body = stripBlocks(body, ["nav", "header", "footer"]);
  }
  const links: string[] = [], seen = new Set<string>();
  // An anchor's text is taken up to its close or 300 characters, whichever comes first.
  for (const match of body.matchAll(/<a\s[^>]{0,2000}?href\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})')[^>]{0,2000}>([^<]{0,300})/gi)) {
    if (links.length >= 128) break;
    try {
      const target = new URL(decodeEntities(match[1] ?? match[2] ?? ""), baseUrl);
      const label = decodeEntities(match[3]).replace(/\s+/g, " ").trim().slice(0, 160);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || !label || seen.has(target.href)) continue;
      seen.add(target.href); links.push(`- link ${JSON.stringify(label)}\n  - /url: ${target.href.slice(0, 1000)}`);
    } catch { /* Not a usable link. */ }
  }
  // The first 100 struck-through passages are marked, as the browser path does; the note is long.
  const marked: boolean[] = []; let marks = 0;
  const struck = (opening: boolean): string => {
    if (opening) { const mark = marks < 100; if (mark) marks++; marked.push(mark); return mark ? " [DELETED/STRUCK-THROUGH TEXT — not current guidance: " : " "; }
    return marked.pop() ? "] " : " ";
  };
  const text = decodeEntities(body
    // Mark where headings and struck-through text begin and end; their inline tags go with the rest below.
    .replace(/<h([1-6])(?:\s[^>]{0,2000})?>/gi, "\n\n\u0001$1\u0002").replace(/<\/h[1-6]\s*>/gi, "\u0003\n")
    .replace(/<(\/?)(?:del|s|strike)(?:\s[^>]{0,2000})?>/gi, (_, closing: string) => struck(!closing))
    .replace(/<\/(?:td|th)\s*>/gi, " | ").replace(/<\/?(?:a|b|i|u|em|strong|span|sup|sub|small|mark|abbr|code|cite|q|time|font|label)(?:\s[^>]{0,4000})?>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|section|article|table|ul|ol|dd|dt|blockquote|pre)\s*>/gi, "\n").replace(/<li(?:\s[^>]{0,2000})?>/gi, "- ")
    .replace(/<[^>]{0,8000}>/g, " "))
    .replace(/\u0001([1-6])\u0002([^\u0001\u0003]{0,400})\u0003/g, (_, level: string, label: string) => {
      const clean = label.replace(/\s+/g, " ").trim();
      return clean ? `- heading ${JSON.stringify(clean)} [level=${level}]` : "";
    }).replace(/[\u0001-\u0003]\d?/g, " ")
    .replace(/[ \t\f\v\u00a0]+/g, " ").replace(/ \|? ?\n ?/g, "\n").replace(/\n /g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, scope: used, content: text && links.length ? `${text}\n\nSource links (first 128, bounded; not additional retrieved evidence):\n${links.join("\n").slice(0, 16000)}` : text };
}

const PDF_SCRIPT = `import sys, json
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
parts, total = [], 0
for index, page in enumerate(reader.pages):
    text = (page.extract_text() or "").strip()
    parts.append('- heading "Page %d" [level=2]\\n%s' % (index + 1, text))
    total += len(text)
    if total > 1000000: break
print(json.dumps({"pages": len(reader.pages), "read": len(parts), "text": "\\n\\n".join(parts)[:1000000]}))
`;

export interface PdfText { content: string; pages: number | null; extractor: string; truncated: boolean }

/** Text of a PDF, extracted offline in the sandbox: the document runtime's
 * pypdf when installed, otherwise pdftotext when the host has it. Undefined
 * when neither is available or the file holds no text layer. */
export async function pdfToText(bytes: Buffer, signal?: AbortSignal, options: { pythonRoot?: string } = {}): Promise<PdfText | undefined> {
  if (bytes.subarray(0, 1024).indexOf("%PDF-") < 0) return undefined;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-pdf-"));
  try {
    await fs.chmod(root, 0o700);
    await fs.writeFile(path.join(root, "source.pdf"), bytes, { mode: 0o600 });
    const runtime = path.resolve(options.pythonRoot ?? defaultDocumentPythonRoot());
    const context = { workspaceRoot: root, signal, allowedWritePaths: [], shellTimeoutMs: 120000, shellMaxOutputBytes: 8 * 1024 * 1024 };
    const hasRuntime = await fs.access(path.join(runtime, "bin/python")).then(() => true, () => false);
    if (hasRuntime) {
      try {
        await fs.writeFile(path.join(root, "extract.py"), PDF_SCRIPT, { mode: 0o600 });
        const run = await createIsolatedExecutor({ network: false, readOnlyRuntimeRoots: [runtime] })(path.join(runtime, "bin/python"), ["-I", "-B", path.join(root, "extract.py"), path.join(root, "source.pdf")], context);
        const data = JSON.parse((run.data as { stdout: string }).stdout) as { pages: number; read: number; text: string };
        if (data.text.replace(/- heading "Page \d+" \[level=2\]/g, "").trim()) return { content: data.text, pages: data.pages, extractor: "pypdf", truncated: data.read < data.pages || data.text.length >= 1000000 };
      } catch (error) { signal?.throwIfAborted(); void error; /* Try the host extractor. */ }
    }
    for (const directory of String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const binary = path.join(directory, "pdftotext");
      if (!await fs.access(binary).then(() => true, () => false)) continue;
      try {
        const run = await createIsolatedExecutor({ network: false })(binary, ["-layout", "-enc", "UTF-8", path.join(root, "source.pdf"), "-"], context);
        const text = (run.data as { stdout: string }).stdout.split("\f").map((page, index) => page.trim() ? `- heading "Page ${index + 1}" [level=2]\n${page.trim()}` : "").filter(Boolean).join("\n\n");
        if (text.trim()) return { content: text.slice(0, 1000000), pages: null, extractor: "pdftotext", truncated: text.length > 1000000 };
      } catch (error) { signal?.throwIfAborted(); void error; }
      break;
    }
    return undefined;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
