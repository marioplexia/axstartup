# Música y efectos originales para el video de lanzamiento (99 BPM)
import numpy as np, soundfile as sf, sys
SR=44100; DUR=63.7; n=int(DUR*SR)+SR
L=np.zeros(n); Rr=np.zeros(n); rng=np.random.default_rng(3)
def add(sig,t,g=1.0,pan=0.0):
    i=int(t*SR)
    if i<0 or i>=n: return
    m=min(len(sig),n-i); L[i:i+m]+=sig[:m]*g*(1-max(0,pan)); Rr[i:i+m]+=sig[:m]*g*(1+min(0,pan))
def ar(d): return np.arange(int(d*SR))/SR
def onepole(x,a):
    y=np.empty_like(x); s=0.0
    for i in range(len(x)): s+=a*(x[i]-s); y[i]=s
    return y
BEAT=60/99; BAR=4*BEAT
CH=[(110.0,[220,261.63,329.63]),(87.31,[174.61,220,261.63]),(130.81,[196,261.63,329.63]),(98.0,[196,246.94,293.66])]
# pad
t=np.arange(n)/SR; pad=np.zeros(n)
for b in range(int(DUR/BAR)+1):
    s=b*BAR; e=min(DUR,s+BAR); i0=int(s*SR); i1=int(e*SR)
    if i1<=i0: continue
    tt=np.arange(i1-i0)/SR; root,notes=CH[b%4]
    v=sum(np.sin(2*np.pi*f*tt)+.3*np.sin(2*np.pi*2*f*tt)+.12*np.sin(2*np.pi*3*f*tt) for f in notes)/3+.6*np.sin(2*np.pi*root*tt)
    env=np.minimum(tt/.4,1)*np.minimum((e-s-tt)/.3,1); pad[i0:i1]+=v*env
lvl=np.interp(t,[0,6,11,12.8,13,58.6,62,63.7],[.5,.6,.7,.35,.8,.8,.5,0])
L+=pad*.06*lvl; Rr+=pad*.06*lvl
# arpegio
def pluck(f,d=.35):
    x=ar(d); return (np.sin(2*np.pi*f*x)+.35*np.sin(2*np.pi*2*f*x)+.1*np.sin(2*np.pi*3*f*x))*np.exp(-x*9)
k=0; tt=0.0
while tt<DUR-1:
    b=int(tt/BAR); notes=CH[b%4][1]; seq=[notes[0]*2,notes[1]*2,notes[2]*2,notes[1]*2,notes[0]*4,notes[2]*2,notes[1]*2,notes[2]*2]
    g=.10 if tt<13 else .14
    if 11.2<tt<13: g=.04
    add(pluck(seq[k%8]),tt,g*(1 if tt<61 else max(0,(63.5-tt)/2.5)),.3 if k%2 else -.3); k+=1; tt+=BEAT/2
# batería
def kick():
    x=ar(.35); f=50+90*np.exp(-x*30); return np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-x*9)
def hat():
    x=ar(.06); s=rng.standard_normal(len(x)); s=s-onepole(s,.35); return s*np.exp(-x*70)
def clap():
    x=ar(.18); s=rng.standard_normal(len(x)); s=onepole(s,.5)-onepole(s,.08); return s*np.exp(-x*22)
bt=0.0; i=0
while bt<DUR:
    if 6.2<=bt<11.0: add(kick(),bt,.35)
    if 13.0<=bt<58.6:
        add(kick(),bt,.55)
        add(hat(),bt+BEAT/2,.12,.2)
        if 18<bt<55 and i%2==1: add(clap(),bt,.12,-.1)
    i+=1; bt+=BEAT
# efectos
def whoosh(d=.7):
    N=int(d*SR); s=rng.standard_normal(N); s=onepole(s,.18)-onepole(s,.02); w=np.sin(np.pi*np.linspace(0,1,N))**2; return s*w
def pop():
    x=ar(.14); return np.sin(2*np.pi*(420+700*np.exp(-x*45))*x)*np.exp(-x*28)
def glitch():
    x=ar(.35); s=np.sign(np.sin(2*np.pi*(180+rng.random()*600)*x))*np.repeat(rng.random(len(x)//300+1),300)[:len(x)]; return s*np.exp(-x*7)*.6
def chime(f=1046.5):
    x=ar(1.2); return (np.sin(2*np.pi*f*x)+.4*np.sin(2*np.pi*f*2.01*x))*np.exp(-x*3.5)*.4
def riser(d):
    N=int(d*SR); s=rng.standard_normal(N); out=np.zeros(N); a=0.0; st=0.0
    al=np.linspace(.01,.4,N)
    for j in range(N): st+=al[j]*(s[j]-st); out[j]=st
    return out*np.linspace(0,1,N)**2
def boom():
    x=ar(1.4); return np.sin(2*np.pi*np.cumsum(40+60*np.exp(-x*8))/SR)*np.exp(-x*3)
for s in [6.2,11.2,14,17.9,20.9,24.9,25.9,30.9,31.9,38.6,42.6,43.9,48.6,53.4,55.6,58.6]: add(whoosh(),s-.35,.35)
add(riser(1.8),11.2,.35); add(boom(),13.0,.7); add(chime(784),13.05,.6)
for s in [20.1,20.35,20.6,26.3,29.1,45.3,45.8,46.3]: add(pop(),s,.35)
for j in range(6): add(pop(),22.8+j*.22,.18)
for s in [31.9,34.0,36.6]: add(glitch(),s,.25)
for s in [40.5,40.7,40.9]: add(pop(),s,.25)
add(chime(1318.5),60.0,.45)
# teclado (muestras del archivo del usuario)
kb,ks=sf.read(sys.argv[2])
if kb.ndim>1: kb=kb.mean(1)
w=int(.004*ks); e=np.sqrt(np.convolve(kb**2,np.ones(w)/w,'same')); thr=e.max()*.25; on=[]; last=-1
for j in range(len(e)):
    if e[j]>thr and (last<0 or j-last>.05*ks): on.append(j); last=j
SN=[]
for q,o in enumerate(on):
    a=max(0,o-int(.004*ks)); nx=on[q+1] if q+1<len(on) else len(kb); z=min(a+int(.12*ks),nx-int(.01*ks))
    if z-a>int(.04*ks): s=kb[a:z].copy(); f=int(.012*ks); s[-f:]*=np.linspace(1,0,f); SN.append(s)
TY=[(0.1,1.5),(2.05,2.45),(3.05,3.45),(4.05,4.35),(5.05,5.45),(7.2,7.7),(8.1,8.7),(9.1,9.9),(9.7,10.6),(12.0,12.7),(13.3,14.0),(14.2,15.4),(15.4,16.6),(18.2,19.6),(41.1,42.2),(42.9,43.6),(44.1,44.7),(44.8,45.6),(49.2,50.5),(53.8,55.3),(55.7,56.2),(56.5,57.2),(57.3,58.0),(60.1,61.3)]
for a,b in TY:
    tt=a
    while tt<b: add(SN[int(rng.integers(len(SN)))]*2.2,tt,.5,float(rng.uniform(-.2,.2))); tt+=.075*float(rng.uniform(.8,1.3))
out=np.stack([L,Rr],1)[:int(DUR*SR)]
fade=np.ones(len(out)); fo=int(1.2*SR); fade[-fo:]=np.linspace(1,0,fo); out*=fade[:,None]
out/=np.abs(out).max()*1.12
sf.write(sys.argv[1],out.astype('float32'),SR); print('ok',len(out)/SR)
