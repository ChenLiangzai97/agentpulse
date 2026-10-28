#!/usr/bin/env python3
"""Exercise real OpenCode session/tools against the P0 local deterministic model."""
import json,time,threading,urllib.request,base64
from pathlib import Path
import probe as p
s=json.loads(p.STATE.read_text());root=Path(s['root']);base=s['base'];records=[];events=[]

def call(path,body=None,method=None):
 result=p.request(base,path,body,method);records.append({'path':path,'method':method or ('POST' if body is not None else 'GET'),'request':body,'response':result});return result

def stream():
 req=urllib.request.Request(base+'/event',headers={'Authorization':'Basic '+base64.b64encode(('opencode:'+p.PASSWORD).encode()).decode()})
 try:
  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=120) as r:
   for line in r:
    if line.startswith(b'data:'):
     try:events.append(json.loads(line[5:]))
     except Exception:pass
 except Exception:pass
threading.Thread(target=stream,daemon=True).start()

def wait_pending(path,sid):
 for _ in range(120):
  result=p.request(base,path)
  hit=next((x for x in result if x.get('sessionID')==sid),None)
  if hit:return hit
  time.sleep(.1)
 raise RuntimeError('pending request not found '+path+' '+sid)

def wait_idle(sid):
 for _ in range(160):
  status=p.request(base,'/session/status').get(sid,{}).get('type','idle')
  if status=='idle':return
  time.sleep(.1)
 raise RuntimeError('session did not become idle')

try:
 for decision in ['once','reject','always']:
  session=call('/session',{'title':'P0 permission '+decision,'permission':[{'permission':'bash','pattern':'*','action':'ask'}]});sid=session['id']
  call(f'/session/{sid}/prompt_async',{'parts':[{'type':'text','text':'P0_PERMISSION '+decision}],'model':{'providerID':'p0','modelID':'fixture-model'}})
  pending=wait_pending('/permission',sid);records.append({'case':'permission pending '+decision,'response':pending})
  call('/permission/'+pending['id']+'/reply',{'reply':decision});wait_idle(sid)
  messages=call(f'/session/{sid}/message');tools=[part for m in messages for part in m['parts'] if part['type']=='tool']
  print('permission',decision,[(t['state']['status'],t['state'].get('output',t['state'].get('error'))) for t in tools])
  if decision=='always':
   call(f'/session/{sid}/prompt_async',{'parts':[{'type':'text','text':'P0_PERMISSION repeat same session'}],'model':{'providerID':'p0','modelID':'fixture-model'}})
   for _ in range(120):
    repeat=p.request(base,f'/session/{sid}/message');repeat_tools=[x for m in repeat for x in m['parts'] if x['type']=='tool']
    if len(repeat_tools)>=2 and repeat_tools[-1]['state']['status'] in ['completed','error']:break
    time.sleep(.1)
   assert len(repeat_tools)>=2 and repeat_tools[-1]['state']['status']=='completed'
   assert not any(x.get('sessionID')==sid for x in p.request(base,'/permission'))
   records.append({'case':'always same-session reuse','tool_count':len(repeat_tools),'last_status':repeat_tools[-1]['state']['status']})
   fresh=call('/session',{'title':'P0 always scope boundary','permission':[{'permission':'bash','pattern':'*','action':'ask'}]})['id']
   call(f'/session/{fresh}/prompt_async',{'parts':[{'type':'text','text':'P0_PERMISSION other session'}],'model':{'providerID':'p0','modelID':'fixture-model'}})
   for _ in range(120):
    fresh_messages=p.request(base,f'/session/{fresh}/message');fresh_tools=[x for m in fresh_messages for x in m['parts'] if x['type']=='tool']
    if fresh_tools and fresh_tools[-1]['state']['status'] in ['completed','error']:break
    time.sleep(.1)
   assert fresh_tools and fresh_tools[-1]['state']['status']=='completed'
   assert not any(x.get('sessionID')==fresh for x in p.request(base,'/permission'))
   records.append({'case':'always authorizes another session in same instance','same_server':True,'same_project':True,'different_session':True,'tool_status':fresh_tools[-1]['state']['status'],'output':fresh_tools[-1]['state'].get('output')})
   print('always scope: new session also auto-authorized; UI must not call this session-only')
 for decision in ['reply','reject']:
  session=call('/session',{'title':'P0 question '+decision});sid=session['id']
  call(f'/session/{sid}/prompt_async',{'parts':[{'type':'text','text':'P0_QUESTION '+decision}],'model':{'providerID':'p0','modelID':'fixture-model'}})
  pending=wait_pending('/question',sid);records.append({'case':'question pending '+decision,'response':pending})
  body={'answers':[['Alpha','Beta'],['P0 freeform note']]} if decision=='reply' else {}
  call('/question/'+pending['id']+'/'+decision,body);wait_idle(sid)
  messages=call(f'/session/{sid}/message');print('question',decision,[(x['state']['status'],x['state'].get('output',x['state'].get('error'))) for m in messages for x in m['parts'] if x['type']=='tool'])
finally:
 (root/'interactions.raw.json').write_text(json.dumps(records,indent=2));(root/'sse.raw.json').write_text(json.dumps(events,indent=2))
 print('SSE types',sorted(set(x.get('type','') for x in events)))
