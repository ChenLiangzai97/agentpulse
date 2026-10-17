#!/usr/bin/env python3
import json,time,urllib.error,urllib.request,base64
from pathlib import Path
import probe as p
from lifecycle import restart
s=json.loads(p.STATE.read_text());root=Path(s['root']);records=[]
def call(path,body=None,method=None):
 try:r=p.request(s['base'],path,body,method)
 except urllib.error.HTTPError as e:r={'http_status':e.code,'body':json.loads(e.read())}
 records.append({'path':path,'request':body,'response':r});return r

def pending(kind,sid):
 for _ in range(100):
  hit=next((x for x in p.request(s['base'],'/'+kind) if x.get('sessionID')==sid),None)
  if hit:return hit
  time.sleep(.1)
 raise RuntimeError('no pending '+kind)

def create(label,permission=None):
 body={'title':label}
 if permission:body['permission']=[{'permission':'bash','pattern':'*','action':'ask'}]
 return call('/session',body)['id']
def send(sid,text):return call(f'/session/{sid}/prompt_async',{'parts':[{'type':'text','text':text}],'model':{'providerID':'p0','modelID':'fixture-model'}})
try:
 # Model deliberately blocks before responding. Abort must interrupt without waiting for its response.
 sid=create('P0 abort');send(sid,'P0_ABORT')
 for _ in range(100):
  if p.request('http://127.0.0.1:'+str(s['mock_port']),'/__state',auth=False)['abort_started']:break
  time.sleep(.1)
 else:raise RuntimeError('Abort probe never reached the streaming model request')
 before=call('/session/status');t=time.monotonic();result=call(f'/session/{sid}/abort',{})
 elapsed=time.monotonic()-t;after=call('/session/status');assert result is True and elapsed<3
 records.append({'case':'abort','model_request_in_flight':True,'busy_before':before.get(sid),'status_after':after.get(sid),'elapsed_seconds':round(elapsed,3)})
 print('abort',elapsed,'seconds',after.get(sid,'idle'))
 for kind,token in [('question','P0_QUESTION'),('permission','P0_PERMISSION')]:
  sid=create('P0 '+kind+' restart',kind=='permission');send(sid,token)
  req=pending(kind,sid);records.append({'case':kind+' pending before restart','response':req})
  # An actual new SSE connection plus GET reconciliation keeps the request discoverable.
  request=urllib.request.Request(s['base']+'/event',headers={'Authorization':'Basic '+base64.b64encode(('opencode:'+p.PASSWORD).encode()).decode()})
  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as stream:
   while True:
    line=stream.readline()
    if line.startswith(b'data:'):
     records.append({'case':kind+' SSE reconnect','response':json.loads(line[5:])});break
  assert any(x['id']==req['id'] for x in call('/'+kind))
  restart(s,pure=True)
  remaining=call('/'+kind);found=any(x['id']==req['id'] for x in remaining)
  records.append({'case':kind+' after process restart','same_request_pending':found})
  if found:
   body={'answers':[['Alpha'],['note']]} if kind=='question' else {'reply':'once'}
   call('/'+kind+'/'+req['id']+'/reply',body)
  else:
   body={'answers':[['Alpha'],['note']]} if kind=='question' else {'reply':'once'}
   stale=call('/'+kind+'/'+req['id']+'/reply',body);print(kind,'pending survives restart',found,'stale reply',stale)
  messages=call(f'/session/{sid}/message')
  print(kind,'post-restart tool states',[(x['state']['status']) for m in messages for x in m['parts'] if x['type']=='tool'])
  send(sid,'P0_HELLO_AFTER_RESTART');time.sleep(.3)
  call(f'/session/{sid}/message')
 # Never assume an accepted client message ID guarantees idempotent part delivery.
 sid=create('P0 message id replay');body={'messageID':'msg_p0replayfixture','noReply':True,'parts':[{'type':'text','text':'P0 same delivery'}],'model':{'providerID':'p0','modelID':'fixture-model'}}
 call(f'/session/{sid}/message',body);call(f'/session/{sid}/message',body)
 messages=call(f'/session/{sid}/message');records.append({'case':'same-messageID replay','messages':len(messages),'text_parts':sum(x['type']=='text' for m in messages for x in m['parts'])})
 print('replayed messageID messages',len(messages),'parts',sum(len(m['parts']) for m in messages))
finally:(root/'recovery.raw.json').write_text(json.dumps(records,indent=2))
