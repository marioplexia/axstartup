const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:720,height:1280}});
p.on('pageerror',e=>console.log('ERR',e.message));
await p.goto('file://'+__dirname+'/reel_style.html');
console.log(JSON.stringify(await p.evaluate(()=>TYEV())));await b.close()})();
