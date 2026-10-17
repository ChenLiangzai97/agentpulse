#!/usr/bin/env python3
"""Offline checks for captured real OpenCode contracts and the P0 go/no-go evidence."""
import hashlib,json,re
from pathlib import Path
root=Path(__file__).resolve().parents[2]/'src/supervisor/providers/__fixtures__/opencode-1.18.35'
def read(name):return json.loads((root/(name+'.json')).read_text())
manifest=read('manifest');spec=read('openapi')
assert manifest['cli_version']=='1.18.35' and manifest['sdk_reference_version']=='1.18.34'
assert len(spec['paths'])==manifest['openapi_paths']==162
for path,method in [('/global/health','get'),('/event','get'),('/session','post'),('/session/{sessionID}/prompt_async','post'),('/session/{sessionID}/abort','post'),('/permission','get'),('/permission/{requestID}/reply','post'),('/question','get'),('/question/{requestID}/reply','post'),('/question/{requestID}/reject','post')]:assert method in spec['paths'][path]
permission=spec['paths']['/permission/{requestID}/reply']['post']['requestBody']['content']['application/json']['schema']
assert permission['properties']['reply']['enum']==['once','always','reject']
interactions=read('interactions')
assert any(r.get('case')=='always same-session reuse' and r['last_status']=='completed' for r in interactions)
assert any(r.get('case')=='always authorizes another session in same instance' and r['same_server'] and r['same_project'] and r['different_session'] for r in interactions)
isolation=read('isolation');assert all(isolation['without_pure'].values()) and not any(isolation['with_pure'].values())
assert isolation['db_paths']==['data/opencode/opencode.db']
credentials=read('credentials');by_case={r['case']:r for r in credentials}
assert not by_case['missing']['key_configured'] and by_case['missing']['native_error']['data']['statusCode']==401
assert by_case['invalid']['key_configured'] and by_case['invalid']['native_error']['data']['statusCode']==401
assert by_case['model_unavailable']['native_error']['data']['statusCode']==404
assert by_case['valid']['native_error'] is None and by_case['valid']['text']==['P0_DONE']
assert all(r['dedicated_file_permissions']=='0o600' for r in credentials)
recovery=read('recovery')
assert any(r.get('case')=='abort' and r['elapsed_seconds']<3 and r['model_request_in_flight'] for r in recovery)
for kind in ['permission','question']:
 assert any(r.get('case')==kind+' SSE reconnect' for r in recovery)
 assert any(r.get('case')==kind+' after process restart' and not r['same_request_pending'] for r in recovery)
assert any(r.get('case')=='same-messageID replay' and r['messages']==1 and r['text_parts']==2 for r in recovery)
types={r.get('type') for r in read('sse')}
assert {'permission.asked','permission.replied','question.asked','question.replied','question.rejected','message.part.updated','message.part.delta','session.status'}<=types
assert read('hello')['directory_matches']
lifecycle=read('lifecycle');assert lifecycle['without_auth_status']==401 and lifecycle['secondary_stopped'] and lifecycle['primary_healthy_after_secondary_stop']
for name,digest in manifest['fixture_sha256'].items():assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest
for file in root.glob('*.json'):
 text=file.read_text()
 assert not re.search(r'/home/[^/\s]+/',text),file.name
 for forbidden in ['/tmp/ap-opencode-p0-','p0-fixture-key','p0-local-test-password-not-production','192.168.']:
  assert forbidden not in text,(file.name,forbidden)
print('PASS: API schemas, plugin controls, key/model failures, real tool/SSE interactions, restart limitations, hashes and redaction')
