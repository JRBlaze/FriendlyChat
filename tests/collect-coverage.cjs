// V8 covers jsdom's real inline renderer as well as Node modules.
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');
const session = new inspector.Session();
session.connect();
session.post('Debugger.enable');
session.post('Profiler.enable');
session.post('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
const exit = process.exit.bind(process);
process.exit = code => {
  session.post('Profiler.takePreciseCoverage',(error,data) => {
    if(error) {console.error(error);exit(1);return;}
    const scripts=[];
    for(const script of data.result) {
      if(!/(?:^|[/\\])(?:friendly-chat\.html|server\.js|main\.js)$/.test(script.url)) continue;
      session.post('Debugger.getScriptSource',{scriptId:script.scriptId},(err,source) => {
        if(!err) scripts.push({...script,source:source.scriptSource});
      });
    }
    fs.mkdirSync(path.join(__dirname,'..','coverage'),{recursive:true});
    const filename = path.basename(process.env.FC_COVERAGE_FILE || 'runtime.json');
    fs.writeFileSync(path.join(__dirname,'..','coverage',filename),JSON.stringify(scripts));
    session.disconnect();exit(code);
  });
};
process.once('beforeExit',()=>process.exit(process.exitCode || 0));
