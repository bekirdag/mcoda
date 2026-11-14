import json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from serve.server import StrataEngine, EngineDied
from serve.test_fatal_recovery import FAKE
from serve import native_load_guard as guard

class NativeGuardIntegration(unittest.TestCase):
    def setUp(self):
        import sys
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.lock=self.root/'gpu.lock';self.policy=self.root/'policy.json'
        self.policy.write_text(json.dumps({'schemaVersion':1,'lockPath':str(self.lock),'waitSeconds':1,
          'minAvailableMiB':1,'restoreReserveMiB':1,'serviceTimeoutSeconds':1,'services':[]}));self.policy.chmod(0o600)
        self.exe=self.root/'native.py';self.exe.write_text('#!'+sys.executable+'\n'+FAKE);self.exe.chmod(0o700)
        self.env={**os.environ,'MCODA_NATIVE_LOAD_POLICY':str(self.policy)}
    def test_constructor_and_restart_both_hold_one_resource_lease(self):
        original=StrataEngine._initialize;receipts=[]
        def observed(engine,*args):
            receipts.append(json.loads(self.lock.read_text())['id'])
            return original(engine,*args)
        with patch.object(StrataEngine,'_initialize',observed):
            engine=StrataEngine(str(self.exe),['--state',str(self.root/'state'),'--mode','illegal'],env=self.env)
            self.addCleanup(engine.close)
            self.assertTrue(engine.alive());self.assertEqual(self.lock.read_bytes(),b'')
            old=engine.proc.pid;engine.restart(tries=1)
            self.assertTrue(engine.alive());self.assertNotEqual(engine.proc.pid,old)
            self.assertEqual(len(receipts),2);self.assertNotEqual(receipts[0],receipts[1]);self.assertEqual(self.lock.read_bytes(),b'')
    def test_lazy_defers_resources_until_load(self):
        engine=StrataEngine(str(self.exe),['--state',str(self.root/'state'),'--mode','illegal'],env=self.env,lazy=True)
        self.addCleanup(engine.close);self.assertFalse(self.lock.exists());self.assertFalse(engine.alive())
        engine.restart(tries=1);self.assertTrue(engine.alive());self.assertEqual(self.lock.read_bytes(),b'')
    def test_ram_rejection_does_not_spawn_native_and_returns_engine_error(self):
        with patch.object(guard,'available_mib',return_value=0):
            with self.assertRaisesRegex(EngineDied,'available RAM'):
                StrataEngine(str(self.exe),['--state',str(self.root/'state'),'--mode','illegal'],env=self.env)
        self.assertFalse((self.root/'state').exists());self.assertEqual(self.lock.read_bytes(),b'')
    def test_failed_restoration_closes_new_engine_and_preserves_fence(self):
        engine=StrataEngine.__new__(StrataEngine)
        with patch.object(guard,'_restore',side_effect=guard.NativeLoadError('fixture restoration failure')):
            with self.assertRaisesRegex(EngineDied,'restoration failure'):
                engine.__init__(str(self.exe),['--state',str(self.root/'state'),'--mode','illegal'],env=self.env)
        self.assertFalse(engine.alive());self.assertEqual(json.loads(self.lock.read_text())['status'],'uncertain')
    def test_restart_ram_refusal_is_bounded_before_native_spawn(self):
        engine=StrataEngine(str(self.exe),['--state',str(self.root/'state'),'--mode','illegal'],env=self.env,lazy=True)
        self.addCleanup(engine.close)
        with patch.object(guard,'available_mib',return_value=0) as probe, patch('serve.server.time.sleep') as sleep:
            with self.assertRaisesRegex(EngineDied,'available RAM'):
                engine.restart()
            self.assertEqual(probe.call_count,1);sleep.assert_not_called()
        self.assertFalse(engine.alive());self.assertEqual(self.lock.read_bytes(),b'')
    def test_default_does_not_load_host_policy(self):
        with patch.object(guard,'read_policy',side_effect=AssertionError('default changed')):
            engine=StrataEngine(str(self.exe),['--state',str(self.root/'state'),'--mode','illegal'])
            self.addCleanup(engine.close);self.assertTrue(engine.alive());self.assertFalse(self.lock.exists())
if __name__=='__main__':unittest.main()
