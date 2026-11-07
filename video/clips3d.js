const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const out=process.argv[2];const b=await chromium.launch({args:['--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto('file://'+__dirname+'/escenas3d.html');await p.waitForFunction('window.ready');
for(let i=0;i<10;i++){fs.mkdirSync(out+'/clip'+i,{recursive:true});
 for(let k=0;k<63;k++){await p.evaluate(([i,t])=>show(i,t),[i,k/24]);
  await p.screenshot({path:out+'/clip'+i+'/f'+String(k).padStart(3,'0')+'.jpg',type:'jpeg',quality:90});}
 console.log('clip',i)}
await b.close()})();
