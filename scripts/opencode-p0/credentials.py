#!/usr/bin/env python3
import json,time,urllib.error,os
from pathlib import Path
import probe as p
from lifecycle import restart
s=json.loads(p.STATE.read_text());root=Path(s['root']);env=json.loads((root/'env.json').read_text());original=json.loads(env['OPENCODE_CONFIG_CONTENT']);records=[]
private=root/'private/provider.json';private.parent.mkdir(mode=0o700);env.pop('OPENCODE_CONFIG_CONTENT',None);env['OPENCODE_CONFIG']=str(private)
(root/'tmp').mkdir(exist_ok=True);env['TMPDIR']=str(root/'tmp');env['OPENCODE_DISABLE_CLAUDE_CODE_SKILLS']='true'
(root/'env.json').write_text(json.dumps(env))
try:
 for mode in ['missing','invalid','model_unavailable','valid']:
  config=json.loads(json.dumps(original));opts=config['provider']['p0']['options'];model='missing-model' if mode=='model_unavailable' else 'fixture-model'
  if mode=='missing':opts.pop('apiKey',None)
  elif mode=='invalid':opts['apiKey']='p0-wrong-test-key'
  private.write_text(json.dumps(config));os.chmod(private,0o600);restart(s,pure=True)
  configured=p.request(s['base'],'/config');providers=p.request(s['base'],'/provider')
  sid=p.request(s['base'],'/session',{'title':'P0 credential '+mode})['id']
  try:r=p.request(s['base'],f'/session/{sid}/message',{'model':{'providerID':'p0','modelID':model},'parts':[{'type':'text','text':'P0_HELLO'}]},timeout=30)
  except urllib.error.HTTPError as e:r={'http_status':e.code,'error':json.loads(e.read())}
  error=r.get('info',{}).get('error',r.get('error'));entry={'case':mode,'key_configured':'apiKey' in opts,'dedicated_file_permissions':oct(private.stat().st_mode & 0o777),'native_error':error,'text':[x.get('text') for x in r.get('parts',[]) if x.get('type')=='text'],'connected':providers.get('connected')}
  records.append(entry);print(json.dumps(entry))
 assert records[-1]['text']==['P0_DONE'] and records[-1]['native_error'] is None
finally:(root/'credentials.raw.json').write_text(json.dumps(records,indent=2))
