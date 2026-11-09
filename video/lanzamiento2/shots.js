const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});
p.on('pageerror',e=>console.log('ERR',e.message));p.on('console',m=>{if(m.type()=='error')console.log('C',m.text())});
await p.goto('file://'+__dirname+'/index.html');await p.waitForFunction('window.ready');
const D=process.argv[2];const T=process.argv.slice(3).map(Number);
for(const t of T){await p.evaluate(t=>setT(t),t);await p.screenshot({path:D+'/x'+String(t).padStart(5,'0')+'.jpg',type:'jpeg',quality:80});}
await b.close()})();
