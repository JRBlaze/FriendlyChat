const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname,'..');
test('original Electron startup owns one server, loads the original app, and keeps the original isolated preload', async () => {
  for(const locked of [false,true]) {
    let servers=0,quits=0,window;
    const app=new EventEmitter();Object.assign(app,{requestSingleInstanceLock:()=>locked,quit:()=>quits++,setAppUserModelId(){},whenReady:()=>Promise.resolve()});
    class BrowserWindow extends EventEmitter {
      constructor(options){super();this.options=options;this.webContents={setWindowOpenHandler(fn){this.open=fn;}};window=this;}
      isDestroyed(){return false;} loadURL(url){this.url=url;}
    }
    const electron={app,BrowserWindow,ipcMain:{handle(){}},shell:{openExternal(){}},nativeImage:{}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'main.js'),'utf8'),{
      __dirname:root,require(name){
        if(name==='electron') return electron;
        if(name==='./server') return {start(){servers++;return {listening:true};}};
        if(name.startsWith('./')) return require(path.join(root,name));
        return require(name);
      },process:{platform:'win32',arch:'x64'},console,setTimeout,
    },{filename:path.join(root,'main.js')});
    await Promise.resolve();
    assert.equal(servers,locked?1:0);assert.equal(quits,locked?0:1);
    if(locked) {
      assert.equal(window.url,'http://localhost:8080/friendly-chat.html');
      assert.equal(window.options.webPreferences.preload,path.join(root,'preload.js'));
      assert.equal(window.options.webPreferences.contextIsolation,true);
      assert.equal(window.options.webPreferences.nodeIntegration,false);
      assert.equal(window.options.webPreferences.nodeIntegrationInSubFrames,undefined);
    } else assert.equal(window,undefined);
  }
});
