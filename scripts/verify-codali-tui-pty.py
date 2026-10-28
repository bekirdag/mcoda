#!/usr/bin/env python3
"""Exercise actual raw terminal input and output; no model, credentials or third-party Python modules."""
import fcntl, hashlib, json, os, pathlib, pty, select, shutil, signal, struct, subprocess, sys, tempfile, termios, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = sys.argv[1] if len(sys.argv) > 1 else 'node'

class Terminal:
    def __init__(self, mode, base, color=False):
        self.workspace = base / ('workspace-' + mode); self.workspace.mkdir(exist_ok=True)
        (self.workspace / 'src').mkdir(exist_ok=True)
        (self.workspace / 'src' / 'main.ts').write_text('export {};\n')
        self.log = base / (mode + '.jsonl')
        config = {'schemaVersion': 1, 'profile': 'fixture', 'providers': {'local': {'adapter': 'openai-compatible', 'baseUrl': 'http://127.0.0.1:1/v1'}}, 'models': {'fixture': {'provider': 'local', 'catalogId': 'fixture', 'revision': 'v1', 'operations': ['chat.completions'], 'contextWindow': 32768, 'maxOutputTokens': 2048, 'supportsTools': True}}, 'bindings': {'lead': {'candidates': ['fixture']}, 'reviewer': {'useBinding': 'lead'}}}
        configuration = base / 'configuration.json'; configuration.write_text(json.dumps(config))
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 90, 0, 0))
        self.original = termios.tcgetattr(self.slave)
        env = dict(os.environ, TERM='xterm-256color')
        if color: env.pop('NO_COLOR', None)
        else: env['NO_COLOR'] = '1'
        self.process = subprocess.Popen([NODE, str(ROOT / 'scripts/fixtures/codali-tui-pty.mjs'), mode, str(self.workspace), str(self.log), str(configuration)], stdin=self.slave, stdout=self.slave, stderr=self.slave, env=env, close_fds=True)
        self.output = b''

    def pump(self, seconds=.1):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], min(.02, max(0, deadline-time.monotonic())))[0]:
                try: chunk = os.read(self.master, 65536)
                except OSError: break
                if not chunk: break
                self.output += chunk

    def wait(self, predicate, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate(): return
            self.pump(.03)
        raise AssertionError('PTY expectation failed: ' + self.output[-1800:].decode(errors='replace'))

    def contains(self, text): self.wait(lambda: text.encode() in self.output)
    def send(self, text): os.write(self.master, text.encode() if isinstance(text, str) else text); self.pump(.08)
    def events(self): return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
    def event(self, expected): self.wait(lambda: expected in self.events())

    def finish(self, terminate=False, command='/quit'):
        if terminate: self.process.send_signal(signal.SIGTERM)
        else: self.send(command + '\r')
        self.wait(lambda: self.process.poll() is not None)
        self.pump()
        assert self.process.returncode == 0
        assert b'\x1b[?1049l' in self.output and b'\x1b[?2004l' in self.output and b'\x1b[?25h' in self.output
        assert termios.tcgetattr(self.slave) == self.original, 'Terminal flags were not restored'
        assert json.loads(pathlib.Path(str(self.log)+'.closed').read_text())['raw'] is False

    def cleanup(self):
        if self.process.poll() is None:
            self.process.kill(); self.process.wait(timeout=3)
        os.close(self.master); os.close(self.slave)
        state = pathlib.Path.home()/'.local/state/codali/workspaces'/hashlib.sha256(str(self.workspace.resolve()).encode()).hexdigest()
        shutil.rmtree(state, ignore_errors=True)

checks = []
with tempfile.TemporaryDirectory(prefix='codali-tui-pty-') as directory:
    base = pathlib.Path(directory)
    ui = Terminal('screen', base)
    try:
        ui.contains('Ask Codali anything')
        ui.send('/stream\r'); ui.contains('stream-')
        ui.send('draft stays editable'); ui.send(b'\x1b[5~'); ui.send(b'\x1b[<64;12;5M'); ui.send(b'\r')
        ui.event({'text': 'draft stays editable', 'intent': 'queue'})
        checks.append('streaming, wheel and keyboard scrolling preserve editable input')
        ui.send('/approval\r'); ui.contains('Permission: fixture')
        ui.send(b'\x1b[200~\x1b[C\r\x1b[201~')
        assert not any('approval' in event for event in ui.events()), 'Paste approved an operation'
        ui.send(b'\r'); ui.event({'approval': 'deny'})
        ui.send('/approval\r')
        ui.send(b'\x1b[<65;12;5M'*30); ui.contains('LAST_ARGUMENT')
        ui.send(b'\x1b[C\r'); ui.event({'approval': 'once'})
        ui.send('/approval\r'); ui.send(b'\x03')
        ui.wait(lambda: sum(event == {'approval': 'deny'} for event in ui.events()) == 2)
        checks.append('default deny, inert paste, complete argument scrolling, explicit approval and cancellation')
        ui.send(b'\x12'); ui.send('previous'); ui.send(b'\r')
        assert {'text': 'previous instruction', 'intent': 'queue'} not in ui.events()
        ui.send(b'\r'); ui.event({'text': 'previous instruction', 'intent': 'queue'})
        ui.send('@src/\t'); ui.contains('Workspace files'); ui.send(b'\r'); ui.send(b'\r')
        ui.event({'text': '@src/main.ts', 'intent': 'queue'})
        ui.send('line one\x1b\rline two\x13'); ui.event({'text': 'line one\nline two', 'intent': 'steer'})
        checks.append('history selection, workspace file completion, multiline steering')
        ui.send('/scroll-fixture\r'); ui.pump(.2)
        ui.send(b'\x1b[<64;12;5M'*80); ui.contains('FIRST_SCROLL_MESSAGE')
        ui.send('/scroll-state\r'); ui.wait(lambda: any('scroll' in event for event in ui.events()))
        before_scroll = [event['scroll'] for event in ui.events() if 'scroll' in event][-1]
        assert before_scroll > 0
        ui.send('/stream\r'); ui.pump(.25); ui.send('/scroll-state\r')
        ui.wait(lambda: len([event for event in ui.events() if 'scroll' in event]) >= 2)
        assert [event['scroll'] for event in ui.events() if 'scroll' in event][-1] >= before_scroll
        checks.append('wheel reaches earlier messages and streaming preserves scrollback position')
        # NO_COLOR preserves cursor controls but never enables an SGR color.
        import re
        assert not re.search(rb'\x1b\[(?:3[0-7]|9[0-7]|[34]8;)[0-9;]*m', ui.output)
        ui.finish(); checks.append('NO_COLOR and clean shutdown restore terminal state')
    finally: ui.cleanup()
    ui = Terminal('startup', base, color=True)
    try:
        ui.contains('Ask Codali anything'); ui.send('test cancellation\r'); ui.event({'initializing': True})
        ui.send(b'\x03'); ui.contains('Cancelled by user before execution')
        assert ui.process.poll() is None, 'First Ctrl-C during initialization exited the TUI'
        assert not any('executionStarted' in event for event in ui.events())
        ui.finish(terminate=True); checks.append('startup cancellation prevents execution; SIGTERM restores terminal')
    finally: ui.cleanup()
    ui = Terminal('resume', base)
    try:
        ui.contains('Saved user objective'); ui.contains('Saved assistant response')
        assert not ui.events(), 'Interactive resume unexpectedly started execution'
        ui.send('/continue\r'); ui.event({'executionStarted': True})
        ui.contains('Continued only by explicit input')
        ui.finish(); checks.append('durable session resume restores conversation and waits for explicit continuation')
    finally: ui.cleanup()
    ui = Terminal('queue', base)
    try:
        ui.contains('Ask Codali anything'); ui.send('First objective\r'); ui.event({'turn': 1, 'objective': 'First objective'})
        ui.send('Queued objective\r'); ui.contains('Message queued')
        ui.event({'turn': 2, 'objective': 'Queued objective'}); ui.contains('Fixture turn 2 complete')
        ui.send('Third objective\r'); ui.event({'turn': 3, 'objective': 'Third objective'})
        ui.send('Correction\x13')
        ui.event({'turn': 4, 'objective': 'Third objective\n\nUser steering: Correction'})
        ui.contains('Fixture turn 4 complete'); ui.finish()
        checks.append('queued messages start after completed goals; steering cancels and amends the active goal')
    finally: ui.cleanup()
    ui = Terminal('commands', base)
    try:
        ui.contains('Ask Codali anything'); ui.send('/new\r'); ui.contains('Fresh session')
        assert not ui.events(), 'An empty /new started inference'
        ui.send('Preserved objective\r'); ui.wait(lambda: len(ui.events()) == 1)
        original = ui.events()[0]['sessionId']
        ui.send('/clear\r'); ui.contains('requires an idle turn')
        ui.send('Queued but cancelled\r'); ui.contains('Message queued')
        ui.send('/stop\r'); ui.contains('Cancelled by user')
        ui.send('/clear\r'); ui.pump(.2)
        ui.send('Fresh objective\r'); ui.wait(lambda: len(ui.events()) == 2)
        assert ui.events()[1]['objective'] == 'Fresh objective', 'Stopped queued work was executed'
        assert ui.events()[1]['sessionId'] != original
        ui.contains('Fixture turn 2 complete')
        ui.send('/new\r'); ui.pump(.2)
        ui.send('/resume ' + original + '\r'); ui.pump(.2)
        assert len(ui.events()) == 2, 'Resume unexpectedly started execution'
        ui.send('/plan diff\r'); ui.contains('From Revision: 1')
        assert len(ui.events()) == 2, 'Plan inspection unexpectedly started inference'
        ui.send(b'\x1b'); ui.pump(.2)
        ui.send('/goal amend Keep original requirements\r'); ui.contains('Keep original requirements')
        assert len(ui.events()) == 2, 'Goal amendment unexpectedly started inference'
        ui.send(b'\x1b'); ui.pump(.2)
        ui.send('/continue\r'); ui.wait(lambda: len(ui.events()) == 3)
        assert ui.events()[2]['sessionId'] == original
        assert ui.events()[2]['objective'] == 'Preserved objective\n\nUser steering: Keep original requirements'
        assert ui.events()[2]['originalObjective'] == 'Preserved objective'
        ui.finish(command='/exit')
        checks.append('new/clear preserve resumable sessions; stop discards queued work; exit restores the terminal')
    finally: ui.cleanup()
    ui = Terminal('models', base)
    try:
        ui.contains('Ask Codali anything')
        current = lambda: json.loads((base / 'configuration.json').read_text())['bindings']['lead']['candidates']
        ui.send('/model select lead unentitled --save\r'); ui.contains('not entitled/advertised')
        assert current() == ['fixture']
        ui.send('/model select lead alternate\r'); ui.contains('Saved: false')
        assert current() == ['fixture'], 'Preview persisted a binding'
        ui.send(b'\x1b'); ui.pump(.2)
        ui.send('/model select lead alternate --save\r'); ui.event({'catalog': 3})
        ui.send('/stop\r'); ui.pump(.8)
        assert current() == ['fixture'], 'Cancelled selection persisted later'
        ui.send('/model select lead alternate --save\r'); ui.contains('Activated: true')
        assert current() == ['alternate']
        ui.send(b'\x1b'); ui.pump(.2); ui.finish(command='/exit')
        assert not any('executionStarted' in event or 'unexpectedRequest' in event for event in ui.events())
        checks.append('model selection verifies entitlement, previews shared scope, cancels pending lookup and saves only explicit choices')
    finally: ui.cleanup()
    ui = Terminal('artifacts', base)
    try:
        ui.contains('Inspect generated artifacts without inference')
        ui.send('/artifacts export pixel cancelled.png\r'); ui.contains('Permission · media_export_artifact')
        ui.send(b'\x03'); ui.contains('Cancelled by user')
        assert not (ui.workspace / 'cancelled.png').exists()
        ui.send('/artifacts export pixel user export.png\r'); ui.pump(.2)
        ui.send(b'\x1b[C\r'); ui.wait(lambda: (ui.workspace / 'user export.png').exists())
        assert (ui.workspace / 'user export.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
        ui.send(b'\x1b'); ui.pump(.2)
        ui.send('/tasks cancel render\r'); ui.contains('Cancel Requested: true')
        ui.send(b'\x1b'); ui.pump(.2); ui.finish(command='/exit')
        assert not any('executionStarted' in event for event in ui.events())
        assert {'cancelRequested': True, 'status': 'running'} in ui.events(), 'Cancellation request was falsely reported as complete'
        checks.append('artifact export supports cancellation and explicit approval; media cancellation retains its pending outcome')
    finally: ui.cleanup()
    ui = Terminal('new-startup', base)
    try:
        ui.contains('Ask Codali anything'); ui.send('/new Cancelled fresh objective\r')
        ui.event({'initializing': True}); ui.send('/stop\r'); ui.pump(.8)
        assert not any('executionStarted' in event for event in ui.events()), 'Stop during /new was lost'
        ui.send('Allowed next objective\r'); ui.event({'executionStarted': True})
        ui.finish(command='/exit'); checks.append('stop during fresh-session preparation prevents later execution')
    finally: ui.cleanup()
print(json.dumps({'passed': True, 'checks': checks}))
