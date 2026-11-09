const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:720,height:1280}});
p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('file://'+__dirname+'/reel_style.html');
const V=await p.evaluate(()=>VIS.map(v=>[v.start,v.end]));const D=process.argv[2];
let i=0;for(const [a,e] of V){await p.evaluate(t=>setT(t),a+(e-a)*0.88);await p.screenshot({path:D+'/s'+String(i++).padStart(2,'0')+'.png'});}
await b.close()})();
