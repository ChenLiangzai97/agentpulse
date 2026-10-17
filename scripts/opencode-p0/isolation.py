#!/usr/bin/env python3
import json,subprocess,time
from pathlib import Path
import probe as p
from lifecycle import restart
s=json.loads(p.STATE.read_text());root=Path(s['root']);env=json.loads((root/'env.json').read_text())
results={}
for scope,folder in [('global-singular',root/'config/opencode/plugin'),('global-plural',root/'config/opencode/plugins'),('project-singular',root/'project/.opencode/plugin'),('project-plural',root/'project/.opencode/plugins')]:
 folder.mkdir(parents=True,exist_ok=True)
 marker=root/(scope+'.loaded')
 (folder/'botmux-ask.js').write_text('import {appendFileSync} from "node:fs"; export const P0Sentinel = async () => { appendFileSync('+json.dumps(str(marker))+',"loaded\\n"); return {event: async () => {}}; };\n')
# Explicit plugin registration is additionally checked, without installing the real BotMux plugin.
explicit=root/'explicit-plugin.js';explicit.write_text('import {appendFileSync} from "node:fs"; export const P0Explicit = async () => { appendFileSync('+json.dumps(str(root/'explicit.loaded'))+',"loaded\\n"); return {}; };\n')
config=json.loads(env['OPENCODE_CONFIG_CONTENT']);config['plugin']=[str(explicit)];env['OPENCODE_CONFIG_CONTENT']=json.dumps(config)
(root/'env.json').write_text(json.dumps(env))
# A positive control proves which probes are valid loaders for this exact binary.
restart(s,pure=False);p.request(s['base'],'/path',timeout=45);p.request(s['base'],'/config',timeout=45);time.sleep(.3)
results['without_pure']={name:f.exists() for name,f in [(x,root/(x+'.loaded')) for x in ['global-singular','global-plural','project-singular','project-plural','explicit']]}
for f in root.glob('*.loaded'):f.unlink()
restart(s,pure=True);p.request(s['base'],'/path',timeout=45);p.request(s['base'],'/config',timeout=45);time.sleep(.3)
results['with_pure']={name:(root/(name+'.loaded')).exists() for name in results['without_pure']}
assert results['without_pure']['explicit'] and any(results['without_pure'][n] for n in ['global-singular','global-plural']) and any(results['without_pure'][n] for n in ['project-singular','project-plural']),results
assert not any(results['with_pure'].values()),results
paths=subprocess.check_output([p.CLI,'debug','paths'],cwd=s['project'],env=env,text=True)
results['debug_paths']=paths
results['db_paths']=[str(f.relative_to(root)) for f in root.rglob('opencode.db')]
(root/'isolation.raw.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
