const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname,'..');
test('original Electron startup owns one server, loads the original app, and keeps the original isolated preload', async () => {
  const saved={x:-1400,y:100,width:900,height:700};
  const relocated={x:136,y:0,width:1100,height:760};
  const cases=[
    {locked:false},
    {locked:true},
    {locked:true,state:'invalid JSON'},
    {locked:true,state:'null'},
    {locked:true,state:'{"x":"invalid"}'},
    {locked:true,state:JSON.stringify({...saved,width:1})},
    {locked:true,state:JSON.stringify({...saved,height:1})},
    {locked:true,state:JSON.stringify(saved),expected:saved,secondary:true},
    {locked:true,state:JSON.stringify({...saved,alwaysOnTop:true}),expected:saved,secondary:true,alwaysOnTop:true},
    {locked:true,state:JSON.stringify({...saved,alwaysOnTop:'true'}),expected:saved,secondary:true},
    {locked:true,state:JSON.stringify({x:5000,y:-300,width:1100,height:1000}),expected:relocated},
    {locked:true,writeFails:true},
  ];
  for(const {locked,state,expected,secondary,writeFails,alwaysOnTop=false} of cases) {
    let servers=0,quits=0,window, warning;
    const userData=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'friendly-chat-test-'));
    const statePath=path.join(userData,'window-state.json');
    try {
    if(state !== undefined) fs.writeFileSync(statePath,state);
    const app=new EventEmitter();Object.assign(app,{requestSingleInstanceLock:()=>locked,quit:()=>quits++,setAppUserModelId(){},whenReady:()=>Promise.resolve(),getPath:()=>userData});
    class BrowserWindow extends EventEmitter {
      constructor(options){super();this.options=options;this.top=options.alwaysOnTop ?? false;this.webContents={setWindowOpenHandler(fn){this.open=fn;}};window=this;}
      isDestroyed(){return false;} loadURL(url){this.url=url;}
      getNormalBounds(){return saved;}
      isAlwaysOnTop(){return this.top;}
      setAlwaysOnTop(value){this.top=value;}
    }
    const handlers=new Map();
    const electron={app,BrowserWindow,ipcMain:{handle(name,fn){handlers.set(name,fn);}},shell:{openExternal(){}},nativeImage:{},
      screen:{getDisplayMatching(){return {workArea:{x:secondary?-1600:0,y:0,width:secondary?1600:1236,height:secondary?900:760}};}}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'main.js'),'utf8'),{
      __dirname:root,require(name){
        if(name==='electron') return electron;
        if(name==='./server') return {start(){servers++;return {listening:true};}};
        if(name.startsWith('./')) return require(path.join(root,name));
        return require(name);
      },process:{platform:'win32',arch:'x64'},console:{...console,warn:(...args)=>{warning=args;}},setTimeout,
    },{filename:path.join(root,'main.js')});
    await Promise.resolve();
    assert.equal(servers,locked?1:0);assert.equal(quits,locked?0:1);
    const updateTop=handlers.get('window-always-on-top');
    assert.equal(updateTop({sender:{}},true),undefined);
    if(locked) {
      const event={sender:window.webContents};
      assert.equal(updateTop(event),alwaysOnTop);
      assert.equal(updateTop(event,'invalid'),alwaysOnTop);
      assert.equal(updateTop(event,!alwaysOnTop),!alwaysOnTop);
      const {x,y,width,height}=window.options;
      assert.deepEqual({x,y,width,height},expected ?? {x:undefined,y:undefined,width:1280,height:800});
      assert.equal(window.url,'http://localhost:8080/friendly-chat.html');
      assert.equal(window.options.webPreferences.preload,path.join(root,'preload.js'));
      assert.equal(window.options.webPreferences.contextIsolation,true);
      assert.equal(window.options.webPreferences.nodeIntegration,false);
      assert.equal(window.options.webPreferences.nodeIntegrationInSubFrames,undefined);
      if(writeFails) fs.mkdirSync(statePath+'.tmp');
      window.emit('close');
      if(writeFails) assert.equal(warning[0],'Could not save window bounds:');
      else {
        assert.deepEqual(JSON.parse(fs.readFileSync(statePath,'utf8')),{...saved,alwaysOnTop:!alwaysOnTop});
        assert.equal(fs.existsSync(statePath+'.tmp'),false);
      }
    } else assert.equal(window,undefined);
    } finally {
      fs.rmSync(userData,{recursive:true,force:true});
    }
  }
});

test('preload forwards window settings through the dedicated IPC channel', () => {
  let api;
  const calls=[];
  vm.runInNewContext(fs.readFileSync(path.join(root,'preload.js'),'utf8'),{
    require:()=>({
      contextBridge:{exposeInMainWorld(name,value){assert.equal(name,'electronAPI');api=value;}},
      ipcRenderer:{invoke(...args){calls.push(args);return true;}},
    }),
  });
  assert.equal(api.alwaysOnTop(),true);
  assert.equal(api.alwaysOnTop(false),true);
  assert.deepEqual(calls,[['window-always-on-top',undefined],['window-always-on-top',false]]);
});
