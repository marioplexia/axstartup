const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const out=process.argv[2];fs.mkdirSync(out,{recursive:true});
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto('file://'+__dirname+'/lanzamiento.html');
const FPS=24,N=120*FPS;
for(let i=0;i<N;i++){await p.evaluate(t=>setT(t),i/FPS);
 await p.screenshot({path:out+'/f'+String(i).padStart(5,'0')+'.jpg',type:'jpeg',quality:92});}
await b.close()})();
