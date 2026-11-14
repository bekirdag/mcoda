import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  browserSessionName,
  createBrowserSessionTools,
} from '../BrowserSessionTool.js';
import { PermissionGate } from '../../../permissions/PermissionGate.js';
import { toolDescriptorFor } from '../../ToolRegistry.js';
import {
  toolActivity,
  toolCompletionSummary,
} from '../../../cli/tui/TerminalPresentation.js';
import { SkillCatalog } from '../../../session/SkillCatalog.js';

test('managed browser actions require external permission and stable workspace ownership', async () => {
  assert.equal(browserSessionName('/one'), browserSessionName('/one'));
  assert.notEqual(browserSessionName('/one'), browserSessionName('/two'));
  for (const tool of createBrowserSessionTools()) {
    await assert.rejects(
      new PermissionGate('plan').authorize(toolDescriptorFor(tool), {})
    );
  }
});

test('browser progress reports observed page and desktop details', () => {
  assert.match(
    toolActivity('browser_session', { action: 'start' }),
    /Starting.*browser/
  );
  assert.match(
    toolCompletionSummary(
      'browser_session',
      {},
      JSON.stringify({ running: true, url: 'http://127.0.0.1:123/vnc.html' })
    ),
    /desktop is ready/
  );
  assert.match(
    toolCompletionSummary(
      'browser_interact',
      {},
      JSON.stringify({ title: 'Demo', text: 'Hello Raijin' })
    ),
    /Demo\nHello Raijin/
  );
});

test('default browser, testing and debugging skills are discoverable and readable', async () => {
  const catalog = new SkillCatalog({
    workspaceRoot: os.tmpdir(),
    includeUser: false,
  });
  await catalog.refresh();
  for (const name of [
    'browser-session',
    'browser-use',
    'webapp-testing',
    'systematic-debugging',
    'docdex-research',
  ]) {
    assert.ok(
      catalog.list().skills.some((skill) => skill.name === name),
      name
    );
    const content = String((await catalog.read(name)).content);
    assert.match(content, name === 'docdex-research' ? /Source: Docdex.*~\/\.codex\/AGENTS\.md/ : /https:\/\//);
  }
});

test(
  'managed desktop persists across callers, serves safe preview, and official Browser Use operates it',
  { skip: process.env.CODALI_TEST_BROWSER_SESSION !== '1', timeout: 240000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'codali-desktop-test-')
    );
    // Container's unprivileged user must be able to read this test workspace.
    await fs.chmod(root, 0o755);
    await fs.writeFile(
      path.join(root, 'index.html'),
      '<title>Codali desktop fixture</title><h1>Ready</h1><input id="name"><button id="submit" onclick="document.querySelector(\'h1\').textContent=\'Hello \'+document.querySelector(\'input\').value">Greet</button>'
    );
    await fs.writeFile(path.join(root, '.env'), 'DO_NOT_SERVE=secret');
    await fs.symlink('/etc/passwd', path.join(root, 'escape'));
    const [session, browser] = createBrowserSessionTools(),
      context = { workspaceRoot: root };
    t.after(async () => {
      await session.handler({ action: 'stop' }, context);
      await fs.rm(root, { recursive: true, force: true });
    });
    const started = JSON.parse(
      (await session.handler({ action: 'start' }, context)).output
    );
    assert.equal(started.running, true);
    assert.match(started.sshForward, /ssh -N -L/);
    // A fresh process must see the same healthy container, without parent shell survival.
    const script = `import {createBrowserSessionTools} from ${JSON.stringify(new URL('../BrowserSessionTool.js', import.meta.url).href)}; console.log((await createBrowserSessionTools()[0].handler({action:'status'},{workspaceRoot:${JSON.stringify(root)}})).output);`;
    const checked = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ]);
    assert.equal(JSON.parse(checked.stdout).url, started.url);
    assert.equal(
      JSON.parse((await session.handler({ action: 'start' }, context)).output)
        .url,
      started.url
    );
    assert.match(
      await (await fetch(started.previewUrl)).text(),
      /Codali desktop fixture/
    );
    for (const file of ['.env', 'escape'])
      assert.equal(
        (await fetch(new URL(file, started.previewUrl))).status,
        403
      );
    const opened = await browser.handler(
      { action: 'open', url: started.previewUrl },
      context
    );
    assert.match(opened.output, /Codali desktop fixture/);
    await browser.handler(
      { action: 'type', selector: '#name', text: 'Raijin' },
      context
    );
    await browser.handler({ action: 'click', selector: '#submit' }, context);
    const state = await browser.handler({ action: 'state' }, context);
    assert.match(state.output, /Hello Raijin/);
    assert.ok(state.output.length <= 3800);
    assert.equal(JSON.parse(state.output).title, 'Codali desktop fixture');
    await assert.rejects(
      browser.handler({ action: 'click', selector: '#missing' }, context),
      /Selector did not match/
    );
    await assert.rejects(
      browser.handler({ action: 'open', url: 'http://127.0.0.1:1/' }, context),
      /Browser navigation failed|net::ERR/
    );
    await session.handler({ action: 'stop' }, context);
    assert.equal(
      JSON.parse((await session.handler({ action: 'status' }, context)).output)
        .running,
      false
    );
  }
);
