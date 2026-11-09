const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:720,height:1280}});
await p.goto('file://'+__dirname+'/reel_prod.html');
const TL=await p.evaluate(()=>TL);const D=process.argv[2];
let i=0;for(const sc of TL){const t=sc.start+Math.min(sc.dur-.2,sc.segs[sc.segs.length-1].st+sc.segs[sc.segs.length-1].dur*0.8);await p.evaluate(t=>setT(t),t);await p.screenshot({path:D+'/r'+String(i++).padStart(2,'0')+'.png'});}
await b.close()})();
