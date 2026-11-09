import json,sys,numpy as np,soundfile as sf
from kokoro_onnx import Kokoro
S=sys.argv[1];k=Kokoro(S+'/kk/kokoro.onnx',S+'/kk/voices.bin');SR=24000
L=json.load(open('/home/user/axstartup/video/lanzamiento2/voz.json'))
buf=np.zeros(int(64*SR),dtype='float32')
for a,b,s in L:
    sp=1.0
    while True:
        au,sr=k.create(s,voice='em_alex',speed=sp,lang='es');d=len(au)/sr
        if d<=b-a or sp>=1.15:break
        sp=round(sp+0.05,2)
    print(f"{a:5.1f} {d:4.2f}/{b-a:4.2f} vel {sp}  {s}")
    i=int(a*SR);m=min(len(au),len(buf)-i);buf[i:i+m]+=au[:m]
sf.write(sys.argv[2],buf,SR)
