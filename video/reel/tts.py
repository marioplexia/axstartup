import json,subprocess,sys,os,wave
S=sys.argv[1];voice=sys.argv[2];out=sys.argv[3]
os.makedirs(out,exist_ok=True)
data=json.load(open('narracion.json'))
res=[];t=0.0
for sc in data:
    segs=[];st=0.0
    for i,(say,cap) in enumerate(sc['s']):
        f=f'{out}/{sc["id"]}_{i}.wav'
        subprocess.run([S+'/tts/venv/bin/python','-m','piper','-m',S+'/tts/'+voice+'/'+voice+'.onnx','--length-scale','0.85','-f',f],input=say.encode(),check=True,capture_output=True)
        w=wave.open(f);d=w.getnframes()/w.getframerate();w.close()
        segs.append({'cap':cap,'file':f,'dur':round(d,3),'st':round(st,3)});st+=d+0.3
    res.append({'id':sc['id'],'segs':segs,'dur':round(st+0.45,3)})
json.dump(res,open(out+'/timeline.json','w'),ensure_ascii=False)
print(sum(r['dur'] for r in res))
