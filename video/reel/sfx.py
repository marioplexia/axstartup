import json,numpy as np,subprocess,sys
SR=44100
js=open('/home/user/axstartup/video/reel/timeline_prod.js').read();TL=json.loads(js[7:-1])
total=TL[-1]['start']+TL[-1]['dur']
n=int((total+1)*SR);L=np.zeros(n);R=np.zeros(n)
rng=np.random.default_rng(7)
def add(sig,t,pan=0.0,g=1.0):
    i=int(t*SR);
    if i<0 or i>=n:return
    m=min(len(sig),n-i);L[i:i+m]+=sig[:m]*g*(1-max(0,pan));R[i:i+m]+=sig[:m]*g*(1+min(0,pan))
def env(d,a=0.005,pw=3):
    x=np.arange(int(d*SR))/SR;return np.minimum(x/a,1)*np.exp(-pw*x/d)
def lp(x,k):
    c=np.cumsum(np.insert(x,0,0));y=(c[k:]-c[:-k])/k;return np.concatenate([y,np.zeros(k-1)])
def whoosh(d=0.7):
    N=int(d*SR);x=rng.standard_normal(N);x=lp(x,40)-lp(x,6);t=np.linspace(0,1,N)
    return x*np.sin(np.pi*t)**2*0.5
def tick(f=2200,d=0.05):
    x=np.arange(int(d*SR))/SR;return (np.sin(2*np.pi*f*x)*0.5+rng.standard_normal(len(x))*0.15)*np.exp(-x*90)
def chime(f=880,d=0.9):
    x=np.arange(int(d*SR))/SR;return (np.sin(2*np.pi*f*x)+0.4*np.sin(2*np.pi*f*2.01*x)+0.2*np.sin(2*np.pi*f*3.02*x))*np.exp(-x*5)*0.25
def pop(d=0.12):
    x=np.arange(int(d*SR))/SR;return np.sin(2*np.pi*(500+800*np.exp(-x*40))*x)*np.exp(-x*30)*0.6

def key(space=False):
    d=0.05;x=np.arange(int(d*SR))/SR
    f=(2250+rng.random()*160) if not space else 1650
    body=np.sin(2*np.pi*f*x)*np.exp(-x*150)+0.45*np.sin(2*np.pi*f*1.52*x)*np.exp(-x*210)+0.2*np.sin(2*np.pi*f*2.3*x)*np.exp(-x*300)
    click=rng.standard_normal(len(x))*np.exp(-x*900)*0.25
    return (body+click)*0.5
def typing(t,nkeys,g=0.55,rate=0.11):
    tt=t
    for i in range(nkeys):
        sp=(i%6==5)
        add(key(sp),tt,float(rng.uniform(-.25,.25)),g*float(rng.uniform(.6,1.0)))
        tt+=rate*float(rng.uniform(.7,1.35))*(1.4 if sp else 1)
# escenas
starts=[0]
VIS=[('intro',0),('subir',0),('subir',1),('orden',0),('rechazo',0),('cerebro',0),('red',0),('cobros',0),('cobros',3),('audit',0),('cierre',0)]
ab={}
for sc in TL:
    for i,g in enumerate(sc['segs']):ab[(sc['id'],i)]=sc['start']+g['st']
for k,(a,b) in enumerate(VIS):
    t=ab[(a,b)]-0.3 if k else 0.0
    add(whoosh(0.8),max(0,t),0.0,0.9)
    add(chime(660+60*(k%4)),max(0,t)+0.15,0.0,0.5)
# ticks de tipeo en v2
t0=ab[('subir',0)]
add(pop(),t0+1.9,0,0.9)
# ticks por frase
# éxitos
add(chime(1175),ab[('subir',1)]+5.3,0,0.6);add(chime(1175),ab[('cobros',2)]+0.6,0,0.6);add(chime(1320),ab[('rechazo',1)]+3.4,0,0.5)

# --- sonido de escritura ---
t0=ab[('subir',0)]
typing(t0+0.5,31,0.8,0.058)
def at(k,i,dl,n,g=0.5):typing(ab[(k,i)]+dl,n,g)
at('intro',0,0.7,12)
at('subir',1,0.6,6);at('subir',1,1.4,6);at('subir',1,2.2,6);at('subir',1,3.0,5);at('subir',1,3.8,6);at('subir',1,5.0,8)
at('orden',0,0.0,10)
at('rechazo',0,0.0,10);at('rechazo',0,1.3,18);at('rechazo',1,0.3,8);at('rechazo',1,3.2,22)
at('cerebro',0,0.0,16);at('cerebro',1,0.0,10);at('cerebro',2,0.0,14)
at('red',0,0.0,16);at('red',1,0.2,14);at('red',1,1.6,12);at('red',1,3.6,10);at('red',1,5.0,18);at('red',2,0.0,8)
at('cobros',0,0.0,12);at('cobros',0,0.6,22);at('cobros',1,0.2,16);at('cobros',2,0.2,10)
at('cobros',3,0.0,14);at('cobros',3,3.6,12)
at('audit',0,0.0,16)
at('cierre',0,0.0,14);at('cierre',0,1.2,14);at('cierre',0,2.4,14);at('cierre',1,0.5,12);at('cierre',1,1.0,18)
# colchón (pad suave)
t=np.arange(n)/SR
pad=sum(np.sin(2*np.pi*f*t)*a for f,a in [(130.8,.5),(196,.35),(261.6,.3),(329.6,.2),(392,.12)])
pad*=(0.5+0.5*np.sin(2*np.pi*0.08*t))*0.6+0.4
pad*=np.minimum(t/3,1)*np.minimum(np.maximum(total-t,0)/4,1)
L+=pad*0.05;R+=pad*0.05
out=np.stack([L,R],1);out/=max(1e-6,np.abs(out).max())*1.05
import soundfile as sf
sf.write(sys.argv[1],out.astype('float32'),SR)
print(total)
