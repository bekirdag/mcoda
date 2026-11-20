import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';

// Neither benchmark arm may be personalized: every Codali session the harness
// builds must turn the user's working style off explicitly.
test('every benchmark SessionController turns working style off', () => {
  const dir=new URL('.',import.meta.url);
  const files=readdirSync(dir).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs'));
  let constructions=0;
  for(const f of files){
    for(const m of readFileSync(new URL(f,dir),'utf8').matchAll(/new SessionController\(\{([^)]{0,40})/g)){
      constructions++; assert.match(m[1],/^workingStyle:false,/,`${f} builds a SessionController without workingStyle:false`);
    }
  }
  assert.ok(constructions>=8);
});
