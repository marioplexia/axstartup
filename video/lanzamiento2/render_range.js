const {chromium}=require('playwright');
(async()=>{const out=process.argv[2],a=+process.argv[3],z=+process.argv[4];
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('file://'+__dirname+'/index.html');await p.waitForFunction('window.ready');
for(let i=a;i<=z;i++){await p.evaluate(t=>setT(t),i/30);await p.screenshot({path:out+'/f'+String(i).padStart(5,'0')+'.jpg',type:'jpeg',quality:90});}
await b.close()})();
