#!/usr/bin/env python3
"""Bounded POSIX terminal smoke; build @mcoda/codali first. Optional argv[1]: Node executable."""
import os,pty,subprocess,tempfile,pathlib,json,time,select,fcntl,termios,struct,signal,hashlib,shutil,sys
base=pathlib.Path(tempfile.mkdtemp(prefix='codali-pty-')); workspace=base/'workspace';workspace.mkdir()
config={'schemaVersion':1,'profile':'pty-fixture','providers':{'local':{'adapter':'openai-compatible','baseUrl':'http://127.0.0.1:1/v1'}},'models':{'fixture':{'provider':'local','catalogId':'fixture','revision':'v1','operations':['chat.completions'],'contextWindow':32768,'maxOutputTokens':2048,'supportsTools':True}},'bindings':{'lead':{'candidates':['fixture']},'reviewer':{'useBinding':'lead'}}}
configuration=base/'configuration.json';configuration.write_text(json.dumps(config));configuration.chmod(0o600)
master,slave=pty.openpty();p=None;captured=b''
def read_until(predicate,seconds=5):
 global captured
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  if predicate(captured):return
  ready,_,_=select.select([master],[],[],0.05)
  if ready:
   try: chunk=os.read(master,65536)
   except OSError:break
   if not chunk:break
   captured+=chunk
 raise AssertionError('Terminal expectation failed: '+captured[-1200:].decode(errors='replace'))
def check_masked_login(node,cancel=False):
 key='synthetic-login-key-12'; secret_prefix=b'synthetic-login-key-1'
 module=(pathlib.Path(__file__).resolve().parent.parent/'packages/codali/dist/cli/TerminalCredentials.js').as_uri()
 source="import assert from 'node:assert/strict';import {readTerminalCredential} from "+json.dumps(module)+";"
 if cancel:
  source+="await assert.rejects(readTerminalCredential(false),/Login cancelled/);"
 else:
  source+="assert.equal(await readTerminalCredential(false),"+json.dumps(key)+");"
 source+="assert.equal(process.stdin.isRaw,false);console.log('MASKED_INPUT_OK');"
 auth_master,auth_slave=pty.openpty();auth_process=None;output=b''
 try:
  auth_process=subprocess.Popen([node,'--input-type=module','-e',source],stdin=auth_slave,stdout=auth_slave,stderr=auth_slave,close_fds=True)
  os.close(auth_slave);auth_slave=None
  def until(marker):
   nonlocal output
   deadline=time.monotonic()+5
   while time.monotonic()<deadline:
    if marker in output:return
    if select.select([auth_master],[],[],0.05)[0]:
     try:chunk=os.read(auth_master,65536)
     except OSError:break
     if not chunk:break
     output+=chunk
   raise AssertionError('Masked input expectation failed: '+output[-1200:].decode(errors='replace'))
  until(b'mSwarm API key: ')
  os.write(auth_master,secret_prefix+(b'\x03' if cancel else b'X\x7f2\r'))
  until(b'MASKED_INPUT_OK');auth_process.wait(timeout=5)
  assert auth_process.returncode==0
  assert secret_prefix not in output,'Input was echoed in plain text'
  assert b'*'*len(secret_prefix) in output,'Input was not masked'
  if not cancel:assert b'\b \b' in output,'Backspace did not erase the mask'
 finally:
  if auth_process and auth_process.poll() is None:auth_process.terminate();auth_process.wait(timeout=5)
  os.close(auth_master)
  if auth_slave is not None:os.close(auth_slave)
try:
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,90,0,0))
 p=subprocess.Popen([sys.argv[1] if len(sys.argv)>1 else 'node',str(pathlib.Path(__file__).resolve().parent.parent/'packages/codali/dist/cli.js'),'chat','--config',str(configuration),'--workspace-root',str(workspace),'--permissions','plan'],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
 os.close(slave);slave=None
 read_until(lambda data:b'codali> ' in data)
 assert b'\x1b[?2004h' in captured
 os.write(master,b'/status\r');read_until(lambda data:b'"busy": false' in data)
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',18,45,0,0));os.kill(p.pid,signal.SIGWINCH)
 os.write(master,'\x1b[200~alpha\n/quit\nβeta\x1b[201~'.encode());time.sleep(0.2)
 assert p.poll() is None,'Pasted /quit executed before submission'
 os.write(master,b'\x15/effort high\r');read_until(lambda data:b'"requested": "high"' in data or b'"effort": "high"' in data)
 os.write(master,b'/quit\r');read_until(lambda data:b'\x1b[?2004l' in data)
 p.wait(timeout=5);assert p.returncode==0
 node=sys.argv[1] if len(sys.argv)>1 else 'node'
 check_masked_login(node);check_masked_login(node,cancel=True)
 print(json.dumps({'passed':True,'checks':['interactive status','terminal resize','multiline paste stays editable','pasted slash command not executed','clear pasted input','effort command','clean quit restores bracketed paste','masked login input and backspace','login cancellation restores terminal']}))
finally:
 if p and p.poll() is None:p.terminate();p.wait(timeout=5)
 os.close(master)
 if slave is not None:os.close(slave)
 state=pathlib.Path.home()/'.local/state/codali/workspaces'/hashlib.sha256(str(workspace.resolve()).encode()).hexdigest()
 shutil.rmtree(state,ignore_errors=True);shutil.rmtree(base,ignore_errors=True)
