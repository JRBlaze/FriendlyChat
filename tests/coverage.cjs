// Portable coverage command: full app suite, real inline renderer coverage,
// Electron bootstrap unit tests, and a 100% shared-feature coverage gate.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
function run(args, filename) {
  const result = spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,FC_COVERAGE_FILE:filename||'runtime.json'}});
  if(result.error) throw result.error;
  if(result.status !== 0) process.exit(result.status || 1);
}
run(['--require','./tests/collect-coverage.cjs','tests/run.js']);
run(['--require','./tests/collect-coverage.cjs','tests/main.test.cjs'],'runtime-main.json');
run([require.resolve('c8/bin/c8.js'),'--include=app-features.js','--include=tests/helpers/coverage-target.cjs','--exclude=node_modules/**','--reports-dir=coverage/features','--check-coverage','--lines=100','--functions=100','--branches=100','--statements=100','--reporter=text','--reporter=json',process.execPath,'--test','tests/features.test.cjs','tests/coverage-target.test.cjs']);
run(['tests/changed-coverage.cjs','coverage/runtime.json','coverage/runtime-main.json']);
