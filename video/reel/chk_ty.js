const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:720,height:1280}});
await p.goto('file://'+__dirname+'/reel_style.html');
console.log(await p.evaluate(()=>TY.map(x=>({id:x.v.id,txt:x.e.textContent.slice(0,22),end:+(x.a+x.total/x.cps).toFixed(2),dur:+(x.v.end-x.v.start).toFixed(2)})).filter(r=>r.end>r.dur-0.7).map(r=>JSON.stringify(r)).join('\n')||'ok'));await b.close()})();
