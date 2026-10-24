#!/usr/bin/env python3
"""P0-only isolated OpenCode contract probes; no AgentPulse production integration."""
import base64, hashlib, json, os, re, shutil, subprocess, tempfile, time, urllib.request
from pathlib import Path

CLI = os.environ.get('P0_OPENCODE_BIN') or shutil.which('opencode') or str(Path.home() / '.opencode/bin/opencode')
STATE = Path('/tmp/agentpulse-opencode-p0-state.json')
PASSWORD = 'p0-local-test-password-not-production'

def request(base, path, body=None, method=None, auth=True, timeout=20):
    headers={'Content-Type':'application/json'}
    if auth: headers['Authorization']='Basic '+base64.b64encode(('opencode:'+PASSWORD).encode()).decode()
    req=urllib.request.Request(base+path, data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=timeout) as r:
        raw=r.read();return (json.loads(raw) if raw else None)

def start():
    root=Path(tempfile.mkdtemp(prefix='ap-opencode-p0-'));os.chmod(root,0o700)
    project=root/'project';project.mkdir();(root/'tmp').mkdir();subprocess.run(['git','init','-q',str(project)],check=True)
    env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG','LC_ALL','TZ','TMPDIR']}
    env.update({
      'XDG_DATA_HOME':str(root/'data'),'XDG_CONFIG_HOME':str(root/'config'),
      'XDG_CACHE_HOME':str(root/'cache'),'XDG_STATE_HOME':str(root/'state'),
      'OPENCODE_CONFIG_DIR':str(root/'config/opencode'),
      'OPENCODE_SERVER_PASSWORD':PASSWORD,'OPENCODE_DISABLE_MODELS_FETCH':'true',
      'OPENCODE_DISABLE_AUTOUPDATE':'true','OPENCODE_DISABLE_LSP_DOWNLOAD':'true',
      'OPENCODE_DISABLE_EXTERNAL_SKILLS':'true','OPENCODE_DISABLE_DEFAULT_PLUGINS':'true',
      'OPENCODE_ENABLE_QUESTION_TOOL':'true','TMPDIR':str(root/'tmp'),'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS':'true',
    })
    (root/'env.json').write_text(json.dumps(env));os.chmod(root/'env.json',0o600)
    with open(root/'server.log','wb') as log:
      proc=subprocess.Popen([CLI,'serve','--pure','--hostname','127.0.0.1','--port','0'],cwd=project,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    STATE.write_text(json.dumps({'root':str(root),'project':str(project),'pid':proc.pid,'base':None}));os.chmod(STATE,0o600)
    for _ in range(200):
      content=(root/'server.log').read_text(errors='replace')
      m=re.search(r'opencode server listening on (http://[^\s]+)',content)
      if m:break
      if proc.poll() is not None:raise RuntimeError('isolated server failed: '+content[-2000:])
      time.sleep(.1)
    else:raise RuntimeError('isolated server startup timeout')
    state={'root':str(root),'project':str(project),'pid':proc.pid,'base':m.group(1)}
    STATE.write_text(json.dumps(state));os.chmod(STATE,0o600)
    spec=request(state['base'],'/doc');(root/'openapi.raw.json').write_text(json.dumps(spec,indent=2))
    print(json.dumps({'pid':proc.pid,'port':m.group(1).rsplit(':',1)[-1], 'health':request(state['base'],'/global/health'),'spec_paths':len(spec['paths'])}))
    print('selected paths',*[p for p in spec['paths'] if any(x in p for x in ['question','permission','prompt_async','/event','/path','abort'])],sep='\n')

if __name__=='__main__':start()
