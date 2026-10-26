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
 print(json.dumps({'passed':True,'checks':['interactive status','terminal resize','multiline paste stays editable','pasted slash command not executed','clear pasted input','effort command','clean quit restores bracketed paste']}))
finally:
 if p and p.poll() is None:p.terminate();p.wait(timeout=5)
 os.close(master)
 if slave is not None:os.close(slave)
 state=pathlib.Path.home()/'.local/state/codali/workspaces'/hashlib.sha256(str(workspace.resolve()).encode()).hexdigest()
 shutil.rmtree(state,ignore_errors=True);shutil.rmtree(base,ignore_errors=True)
