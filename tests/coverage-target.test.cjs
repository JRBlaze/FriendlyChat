const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverageDiffArgs } = require('./helpers/coverage-target.cjs');

test('local coverage checks uncommitted changes when no base is supplied',()=> {
  assert.deepEqual(coverageDiffArgs('friendly-chat.html'),['diff','--unified=0','--','friendly-chat.html']);
});
test('CI coverage resolves its base and includes committed and working-tree changes',()=> {
  const sha='0123456789012345678901234567890123456789';
  const args=coverageDiffArgs('main.js','origin/main',(command,args,options)=> {
    assert.equal(command,'git');
    assert.deepEqual(args,['rev-parse','--verify','--end-of-options','origin/main^{commit}']);
    assert.equal(options.encoding,'utf8');return sha+'\n';
  });
  assert.deepEqual(args,['diff','--unified=0',sha,'--','main.js']);
});
test('unknown or option-like coverage bases fail closed',()=> {
  assert.throws(()=>coverageDiffArgs('server.js','missing-ref',()=>{throw Error('unknown ref');}),/unknown ref/);
  assert.throws(()=>coverageDiffArgs('server.js','--help'));
});
