// Gate changed executable renderer/Node lines, functions and V8 block ranges.
// This deliberately reports changed-code coverage separately from the old app.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { coverageDiffArgs } = require('./helpers/coverage-target.cjs');
const root = path.resolve(__dirname,'..');
const scripts = process.argv.slice(2).flatMap(file=>JSON.parse(fs.readFileSync(file,'utf8')));
let failed=false;
for(const filename of ['friendly-chat.html','server.js','main.js']) {
  const raw=fs.readFileSync(path.join(root,filename),'utf8');
  const full=filename.endsWith('.html')?raw.replace(/\r\n/g,'\n'):raw;
  const lines=full.split('\n'), changed=new Set();
  let line=0;
  const diffArgs=coverageDiffArgs(filename,process.env.FC_COVERAGE_BASE);
  for(const text of execFileSync('git',diffArgs,{cwd:root,encoding:'utf8'}).split('\n')) {
    const hunk=/^@@ .* \+(\d+)(?:,\d+)? @@/.exec(text);
    if(hunk) {line=Number(hunk[1]);continue;}
    if(text.startsWith('+++')||text.startsWith('---')) continue;
    if(text.startsWith('+')) changed.add(line++);
    else if(text.startsWith(' ')) line++;
  }
  const matches=scripts.filter(s=>decodeURIComponent(s.url).replace(/\\/g,'/').endsWith('/'+filename));
  const ranges=new Map(), functions=new Map(), versions=new Map();
  for(const script of matches) {
    const base=filename.endsWith('.html')?full.indexOf(script.source):0;
    if(base<0) continue;
    for(const func of script.functions) {
      const first=func.ranges[0];
      const functionKey=`${base+first.startOffset}:${base+first.endOffset}`;
      const old=functions.get(functionKey);
      functions.set(functionKey,{start:base+first.startOffset,end:base+first.endOffset,count:(old?.count||0)+first.count,name:func.functionName});
      if(!versions.has(functionKey)) versions.set(functionKey,[]);
      versions.get(functionKey).push(func.ranges.map(r=>({...r,start:r.startOffset+base,end:r.endOffset+base})));
      for(const range of func.ranges) {
        const key=`${functionKey}:${base+range.startOffset}:${base+range.endOffset}`;
        const prev=ranges.get(key);
        ranges.set(key,{start:base+range.startOffset,end:base+range.endOffset,count:(prev?.count||0)+range.count,branch:range!==first,owner:functionKey});
      }
    }
  }
  // V8 omits a block range when it has the same hit count as its enclosing
  // range. Infer those hits from that script's enclosing range when merging.
  for(const range of ranges.values()) {
    range.count=versions.get(range.owner).reduce((count,list)=> {
      const enclosing=list.filter(r=>r.start<=range.start&&r.end>=range.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start));
      return count+enclosing[0].count;
    },0);
  }
  const offsets=[0];for(let i=0;i<full.length;i++) if(full[i]==='\n') offsets.push(i+1);
  let runtimeStart=0,runtimeEnd=full.length;
  if(filename.endsWith('.html')) {runtimeStart=full.lastIndexOf('<script>')+8;runtimeEnd=full.lastIndexOf('</script>');}
  const executable=[...changed].filter(n=> {
    const text=lines[n-1].trim();
    return offsets[n-1]>=runtimeStart && offsets[n-1]<runtimeEnd && text && !/^\/\/|^\*|^\/\*/.test(text) && !/^[{}\]);,]+$/.test(text);
  });
  const intersects = range=>executable.some(n=>range.start<offsets[n] && range.end>offsets[n-1]);
  const missingLines=[];
  for(const n of executable) {
    const at=offsets[n-1]+lines[n-1].search(/\S/);
    const applicable=[...ranges.values()].filter(r=>r.start<=at&&r.end>at).sort((a,b)=>(a.end-a.start)-(b.end-b.start));
    if(!applicable.length || !applicable[0].count) missingLines.push(n);
  }
  const touchedFunctions=[...functions.values()].filter(intersects);
  const branches=[...ranges.values()].filter(r=>r.branch&&intersects(r));
  const missingFunctions=touchedFunctions.filter(r=>!r.count), missingBranches=branches.filter(r=>!r.count);
  const report=(label,total,missing)=>`${label} ${total-missing}/${total}`;
  console.log(filename+': '+[report('lines',executable.length,missingLines.length),report('functions',touchedFunctions.length,missingFunctions.length),report('ranges',branches.length,missingBranches.length)].join(', '));
  for(const n of missingLines) console.log(`  line ${n}: ${lines[n-1].trim()}`);
  for(const range of [...missingFunctions,...missingBranches]) console.log(`  ${range.name||'range'} at ${full.slice(0,range.start).split('\n').length}: ${full.slice(range.start,range.end).slice(0,180).replace(/\n/g,' ')}`);
  if(missingLines.length||missingFunctions.length||missingBranches.length) failed=true;
}
if(failed) process.exitCode=1;
