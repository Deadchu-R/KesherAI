"""Adds design-doc boards made from screenshots: python3 shotboard.py NAME.dc.html "title" shot.png [width] [NAME2 "title2" shot2.png [width2] ...]
Boards go in one new row below everything (computer first, phone after), each gets a design_marks entry
(the last one becomes "the newest change"), then design_marks.py lays out the marks. Publish afterwards (LEAD_GUIDE.md).
A NAME that is already on the canvas is updated in place (same spot, new picture, marked "עודכן:" instead of "חדש:")."""
import sys, json, base64, re, time
from PIL import Image
import os
S=os.environ.get('DESIGN_DIR') or os.path.expanduser('~/design-work')
P=S+'/design2/project/'
head=open(P+'SceneTogether.dc.html').read()
head=head[:head.find('</style></helmet>')+len('</style></helmet>')]
args=sys.argv[1:]; items=[]
while args:
    name,title,png=args[:3]; args=args[3:]
    w=None
    if args and args[0].isdigit(): w=int(args.pop(0))
    items.append((name,title,png,w))
c=json.load(open(P+'canvas.json'))
y=max(b.get('y',0)+b.get('h',0) for b in c['boards'].values())+300; x=0
m=json.load(open(S+'/design_marks.json'))
stamp=time.strftime('%d.%m %H:%M', time.localtime(time.time()+2*3600))
for name,title,png,w in items:
    im=Image.open(png); iw,ih=im.size
    w=w or (390 if iw<1000 and ih>iw else 1200); h=round(ih*w/iw)
    b64=base64.b64encode(open(png,'rb').read()).decode()
    t=title.replace('&','&amp;').replace('"','&quot;').replace('<','&lt;')
    html=re.sub(r'<title>.*?</title>',f'<title>{t}</title>',head)
    html+=f'<div class="b" style="width:{w}px;height:{h}px;position:relative;overflow:hidden"><img src="data:image/png;base64,{b64}" style="width:{w}px;height:{h}px;display:block" alt="{t}"></div></x-dc><script type="text/x-dc" data-dc-script data-props=\'{{"$preview":{{"width":{w},"height":{h}}}}}\'>class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}</script></body></html>'
    open(P+name,'w').write(html)
    old=c['boards'].get(name)
    if old:
        old.update({'h':h,'w':w,'title':title}); m.append([name,stamp,'עודכן: '+title]); continue
    c['boards'][name]={'h':h,'title':title,'w':w,'x':x,'y':y}
    if name not in c['order']: c['order'].append(name)
    m.append([name,stamp,'חדש: '+title]); x+=w+400
json.dump(c,open(P+'canvas.json','w'),ensure_ascii=False,indent=1)
json.dump(m,open(S+'/design_marks.json','w'),ensure_ascii=False)
print('added',[i[0] for i in items],'at y',y)
