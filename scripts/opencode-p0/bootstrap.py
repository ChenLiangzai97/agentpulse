#!/usr/bin/env python3
import json,subprocess,sys,time
from pathlib import Path
import probe as p
from lifecycle import restart
s=json.loads(p.STATE.read_text());root=Path(s['root'])
with open(root/'mock.log','wb') as log:
 proc=subprocess.Popen([sys.executable,str(Path(__file__).with_name('mock_model.py').resolve())],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
s['mock_pid']=proc.pid;p.STATE.write_text(json.dumps(s))
for _ in range(100):
 try:port=int((root/'mock.log').read_text().splitlines()[0]);break
 except (ValueError,IndexError):time.sleep(.05)
else:raise RuntimeError('mock startup failed')
s['mock_port']=port
config={'model':'p0/fixture-model','small_model':'p0/fixture-model','enabled_providers':['p0'],'snapshot':False,'share':'disabled','provider':{'p0':{'npm':'@ai-sdk/openai-compatible','name':'P0 fixture','options':{'baseURL':f'http://127.0.0.1:{port}/v1','apiKey':'p0-fixture-key','timeout':20000},'models':{'fixture-model':{'name':'P0 fixture','tool_call':True,'limit':{'context':32768,'output':2048}},'missing-model':{'name':'P0 missing','limit':{'context':32768,'output':2048}}}}}}
env=json.loads((root/'env.json').read_text());env['OPENCODE_CONFIG_CONTENT']=json.dumps(config)
(root/'env.json').write_text(json.dumps(env));p.STATE.write_text(json.dumps(s));restart(s)
session=p.request(s['base'],'/session',{'title':'P0 create / send fixture'})
assert session['directory']==s['project']
r=p.request(s['base'],f"/session/{session['id']}/message",{'parts':[{'type':'text','text':'P0_HELLO'}],'model':{'providerID':'p0','modelID':'fixture-model'}})
assert any(x.get('text')=='P0_DONE' for x in r['parts'])
(root/'hello.raw.json').write_text(json.dumps({'session':session,'reply':r,'directory_matches':True},indent=2))
print('Create / send / directory: PASS')
