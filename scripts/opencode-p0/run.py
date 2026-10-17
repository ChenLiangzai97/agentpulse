#!/usr/bin/env python3
"""Regenerate P0 fixtures with real OpenCode and a local mock model; always clean probes."""
import hashlib,json,os,shutil,signal,subprocess,sys,time
from pathlib import Path
import probe as p
here=Path(__file__).resolve().parent
plugin=Path.home()/'.config/opencode/plugin/botmux-ask.js'
before=hashlib.sha256(plugin.read_bytes()).hexdigest() if plugin.exists() else None
if p.STATE.exists():raise SystemExit('Existing P0 manifest: clean its owned processes before starting another run')
root=None
try:
 p.start();root=Path(json.loads(p.STATE.read_text())['root'])
 for script in ['bootstrap.py','exercise.py','isolation.py','recovery.py','credentials.py','finish.py']:
  subprocess.run([sys.executable,str(here/script)],check=True)
except Exception:
 if p.STATE.exists():
  state=json.loads(p.STATE.read_text());failed_root=Path(state['root'])
  for log in failed_root.rglob('*.log'):
   lines=log.read_text(errors='replace').splitlines()
   print('P0 diagnostic',log.name,'\n'.join(lines[-8:]),flush=True)
 raise
finally:
 if p.STATE.exists():
  state=json.loads(p.STATE.read_text());root=Path(state['root'])
  for field in ['pid','mock_pid']:
   pid=state.get(field)
   if not pid:continue
   try:
    cmd=Path(f'/proc/{pid}/cmdline').read_bytes()
    if field=='pid' and (b'opencode' not in cmd or Path(f'/proc/{pid}/cwd').resolve()!=Path(state['project'])):raise RuntimeError('Refusing to stop unknown process')
    if field=='mock_pid' and b'mock_model.py' not in cmd:raise RuntimeError('Refusing to stop unknown mock process')
    os.killpg(pid,signal.SIGTERM)
   except ProcessLookupError:pass
   except FileNotFoundError:pass
  time.sleep(.3);shutil.rmtree(root);p.STATE.unlink()
 if before is not None:assert hashlib.sha256(plugin.read_bytes()).hexdigest()==before,'Production plugin changed'
 print('Probe services and private directories cleaned; production plugin unchanged')
