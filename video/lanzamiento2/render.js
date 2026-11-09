const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const out=process.argv[2];fs.mkdirSync(out,{recursive:true});
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('file://'+__dirname+'/index.html');await p.waitForFunction('window.ready');
const FPS=30,N=Math.round(63.7*FPS);
for(let i=0;i<N;i++){await p.evaluate(t=>setT(t),i/FPS);await p.screenshot({path:out+'/f'+String(i).padStart(5,'0')+'.jpg',type:'jpeg',quality:90});}
await b.close()})();
