#!/usr/bin/env python3
"""Capture lifecycle evidence, export sanitized fixtures and stop only probe-owned services."""
import base64,hashlib,json,os,re,shutil,signal,time,urllib.error
from pathlib import Path
import probe as p
s=json.loads(p.STATE.read_text());root=Path(s['root']);records={}
try:p.request(s['base'],'/global/health',auth=False)
except urllib.error.HTTPError as e:records['without_auth_status']=e.code
# Keep the primary manifest safe even if the secondary collision probe fails.
try:
 p.start();second=json.loads(p.STATE.read_text())
 records['port_zero_first']=s['base'].rsplit(':',1)[-1]
 records['port_zero_when_preferred_port_busy']=second['base'].rsplit(':',1)[-1]
 records['distinct_private_directories']=s['project']!=second['project']
 os.kill(second['pid'],signal.SIGTERM);time.sleep(.2)
 try:p.request(second['base'],'/global/health',timeout=1);records['secondary_stopped']=False
 except Exception:records['secondary_stopped']=True
 shutil.rmtree(second['root'])
finally:
 # Even failed secondary startup must not leave an isolated instance behind.
 candidate=json.loads(p.STATE.read_text()) if p.STATE.exists() else s
 if candidate['root']!=s['root']:
  try:
   cmd=Path(f"/proc/{candidate['pid']}/cmdline").read_bytes()
   if b'opencode' in cmd and Path(f"/proc/{candidate['pid']}/cwd").resolve()==Path(candidate['project']):
    os.killpg(candidate['pid'],signal.SIGTERM)
  except (FileNotFoundError,ProcessLookupError):pass
  shutil.rmtree(candidate['root'],ignore_errors=True)
 p.STATE.write_text(json.dumps(s))
records['primary_healthy_after_secondary_stop']=p.request(s['base'],'/global/health')['healthy']
# Endpoint directory context is not an authorization boundary.
other=root/'other-project';other.mkdir(exist_ok=True)
from urllib.parse import quote
path=p.request(s['base'],'/path?directory='+quote(str(other),safe=''))
records['explicit_directory_query_supported']=path['directory']==str(other)
records['primary_default_directory_correct']=p.request(s['base'],'/path')['directory']==s['project']
(root/'lifecycle.raw.json').write_text(json.dumps(records,indent=2))
output=Path(__file__).resolve().parents[2]/'src/supervisor/providers/__fixtures__/opencode-1.18.35';output.mkdir(parents=True,exist_ok=True)
ids={};counts={}
def sanitize_string(value):
 value=value.replace(str(root),'<P0_ROOT>').replace(str(Path.home()),'<USER_HOME>')
 value=value.replace(p.PASSWORD,'<SERVER_PASSWORD>').replace('p0-fixture-key','<MODEL_KEY>').replace('p0-wrong-test-key','<INVALID_MODEL_KEY>')
 value=re.sub(r'127\.0\.0\.1:\d+','127.0.0.1:<PORT>',value)
 def replace_id(match):
  token=match.group();prefix=token.split('_')[0]
  if token not in ids:counts[prefix]=counts.get(prefix,0)+1;ids[token]=prefix+'_fixture'+str(counts[prefix])
  return ids[token]
 return re.sub(r'\b(?:ses|msg|prt|per|que|err)_[A-Za-z0-9]+\b',replace_id,value)
def sanitize(value):
 if isinstance(value,str):return sanitize_string(value)
 if isinstance(value,list):return [sanitize(x) for x in value]
 if isinstance(value,dict):return {sanitize_string(k):sanitize(v) for k,v in value.items()}
 return value
# Annotate scope dimensions from the captured session creation responses, not from docs.
interaction_file=root/'interactions.raw.json'
if interaction_file.exists():
 interactions=json.loads(interaction_file.read_text())
 created={r['request'].get('title'):r['response'] for r in interactions if r.get('path')=='/session' and isinstance(r.get('request'),dict)}
 original=created.get('P0 permission always',{});fresh=created.get('P0 always scope boundary',{})
 for entry in interactions:
  if entry.get('case')=='always authorizes another session in same instance':
   entry.update(same_server=True,same_project=original.get('directory')==fresh.get('directory'),different_session=original.get('id')!=fresh.get('id'))
 interaction_file.write_text(json.dumps(interactions,indent=2))
for file in sorted(root.glob('*.raw.json')):
 (output/file.name.replace('.raw','')).write_text(json.dumps(sanitize(json.loads(file.read_text())),indent=2,ensure_ascii=False)+'\n')
manifest={'cli_version':p.request(s['base'],'/global/health')['version'],'sdk_reference_version':'1.18.34','real_opencode_server':True,'model_backend':'local deterministic OpenAI-compatible fixture; no live provider credentials','openapi_paths':len(json.loads((root/'openapi.raw.json').read_text())['paths']),'id_sanitization':'stable per-export placeholders','schema_namespace_note':'SDK v2 does not imply storage V2','findings':{'process_restart_drops_native_pending_requests':True,'same_messageID_replay_adds_text_parts':True,'global_and_project_plugins_disabled_by_pure':True,'provider_connected_does_not_validate_credentials':True,'always_authorizes_another_session_in_same_instance':True},'fixture_sha256':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(output.glob('*.json')) if f.name!='manifest.json'}}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Sanitized fixtures exported:',len(manifest['fixture_sha256']))
