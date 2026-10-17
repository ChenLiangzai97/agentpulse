#!/usr/bin/env python3
"""Helpers for only the P0-owned process recorded in its private manifest."""
import json,os,signal,subprocess,time,re
from pathlib import Path
import probe as p

def restart(s,pure=True):
 root=Path(s['root']);old=s['pid']
 # Do not act on a PID unless its cmdline identifies our CLI and isolated cwd.
 cmd=Path(f'/proc/{old}/cmdline').read_bytes()
 if b'opencode' not in cmd or Path(f'/proc/{old}/cwd').resolve()!=Path(s['project']):raise RuntimeError('P0 process identity mismatch')
 os.kill(old,signal.SIGTERM)
 for _ in range(100):
  try:
   status=Path(f'/proc/{old}/stat').read_text().split()[2]
   if status=='Z':break
  except FileNotFoundError:break
  time.sleep(.05)
 else:raise RuntimeError('P0 process did not exit')
 env=json.loads((root/'env.json').read_text())
 with open(root/'server.log','wb') as log:
  proc=subprocess.Popen([p.CLI,'serve']+(['--pure'] if pure else [])+['--hostname','127.0.0.1','--port','0'],cwd=s['project'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 for _ in range(200):
  m=re.search(r'opencode server listening on (http://[^\s]+)',(root/'server.log').read_text())
  if m:break
  if proc.poll() is not None:raise RuntimeError('P0 startup failed')
  time.sleep(.05)
 else:raise RuntimeError('P0 startup timeout')
 s.update(pid=proc.pid,base=m.group(1));p.STATE.write_text(json.dumps(s));return s
