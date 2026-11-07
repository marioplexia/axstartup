const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch({args:['--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('ERR',e.message));p.on('console',m=>console.log('LOG',m.text()));
await p.goto('file://'+__dirname+'/escenas3d.html');await p.waitForFunction('window.ready');
const D=process.argv[2];const which=process.argv.slice(3).map(Number);
for(const i of which){const t0=Date.now();await p.evaluate(i=>show(i,1.3),i);await p.screenshot({path:D+'/c'+i+'.jpg',type:'jpeg',quality:88});console.log(i,Date.now()-t0,'ms')}
await b.close()})();
