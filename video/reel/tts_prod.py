import json,sys,os,wave,array
import soundfile as sf
from kokoro_onnx import Kokoro
S=sys.argv[1];voice=sys.argv[2];speed=float(sys.argv[3]);GAP=0.3
k=Kokoro(S+'/kk/kokoro.onnx',S+'/kk/voices.bin')
data=json.load(open('narracion_prod.json'));TL=[];cur=0.0;chunks=[]
SR=24000
for sc in data:
    st=0.0;segs=[]
    for say,cap in sc['s']:
        a,sr=k.create(say,voice=voice,speed=speed,lang='es');d=len(a)/sr
        segs.append({'cap':cap,'st':round(st+0.2,3),'dur':round(d,3),'a':a});st+=d+GAP
    dur=st+0.45
    TL.append({'id':sc['id'],'start':round(cur,3),'dur':round(dur,3),'segs':segs});cur+=dur
import numpy as np
buf=np.zeros(int((cur+1)*SR),dtype='float32')
for sc in TL:
    for g in sc['segs']:
        o=int((sc['start']+g['st'])*SR);buf[o:o+len(g['a'])]=g['a']
sf.write(S+'/voz_prod.wav',buf,SR)
for sc in TL:
    for g in sc['segs']:del g['a']
open('timeline_prod.js','w').write('var TL='+json.dumps(TL,ensure_ascii=False)+';')
print(cur)
