#!/usr/bin/env python3
"""Loopback-only deterministic OpenAI-compatible fixture provider. No real credentials/LLM."""
import json,os,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

RECORD=os.environ.get('P0_RECORD_FILE')
SLOW_EVERY=os.environ.get('P0_SLOW_EVERY')
class Handler(BaseHTTPRequestHandler):
 abort_started = False
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/__state':
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'abort_started':Handler.abort_started}).encode());return
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
  self.wfile.write(json.dumps({'data':[{'id':'fixture-model','object':'model'}]}).encode())
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
  if RECORD:
   with open(RECORD,'a') as fh:fh.write(json.dumps({'t':time.time(),'model':body.get('model'),'messages':[{'role':m.get('role'),'text':(m.get('content') if isinstance(m.get('content'),str) else json.dumps(m.get('content')))[:80]} for m in body.get('messages',[])]})+'\n')
  if self.headers.get('Authorization')!='Bearer p0-fixture-key':
   self.send_response(401);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"error":{"message":"P0 invalid test credential","type":"authentication_error","code":"invalid_api_key"}}');return
  if body.get('model')=='missing-model':
   self.send_response(404);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"error":{"message":"P0 model not available","type":"invalid_request_error","code":"model_not_found"}}');return
  messages=body.get('messages',[])
  users=[(i,m) for i,m in enumerate(messages) if m.get('role')=='user'];i,user=users[-1] if users else (0,{})
  content=user.get('content','');content=content if isinstance(content,str) else json.dumps(content)
  done=any(m.get('role')=='tool' for m in messages[i+1:])
  tool=None
  if 'P0_ABORT' in content and body.get('stream') and not done:
   Handler.abort_started=True;time.sleep(15)
  if SLOW_EVERY and body.get('stream'):
   time.sleep(8)
  if not done and body.get('tools'):
   if 'P0_PERMISSION' in content:tool=('bash',{'command':'printf P0_PERMISSION_OUTPUT','description':'P0 safe permission probe'})
   elif 'P0_QUESTION' in content:tool=('question',{'questions':[{'question':'Pick fixture options','header':'P0 fixture','options':[{'label':'Alpha','description':'A'},{'label':'Beta','description':'B'}],'multiple':True,'custom':True},{'question':'Enter fixture note','header':'P0 note','options':[{'label':'Default','description':'Use default'}],'custom':True}]})
  recall=''
  if 'P0_RECALL' in content:
   recall=next((m.get('content') for m in messages if m.get('role')=='user' and isinstance(m.get('content'),str) and 'P1FORKSRC-' in m.get('content')),'')
  self.send_response(200)
  if body.get('stream'):
   self.send_header('Content-Type','text/event-stream');self.end_headers()
   def chunk(delta,finish=None):
    obj={'id':'chatcmpl-p0','object':'chat.completion.chunk','created':1,'model':'fixture-model','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
    self.wfile.write(('data: '+json.dumps(obj)+'\n\n').encode());self.wfile.flush()
   try:
    chunk({'role':'assistant'})
    if tool:chunk({'tool_calls':[{'index':0,'id':'call_p0_'+tool[0],'type':'function','function':{'name':tool[0],'arguments':json.dumps(tool[1])}}]});chunk({},'tool_calls')
    elif recall:chunk({'content':'P0_RECALLED '+recall.strip()[:160]});chunk({},'stop')
    else:chunk({'content':'P0_DONE'});chunk({},'stop')
    self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
   except (BrokenPipeError,ConnectionResetError):pass
  else:
   self.send_header('Content-Type','application/json');self.end_headers()
   self.wfile.write(json.dumps({'id':'chatcmpl-p0','object':'chat.completion','created':1,'model':'fixture-model','choices':[{'index':0,'message':{'role':'assistant','content':'P0 fixture title'},'finish_reason':'stop'}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}).encode())

if __name__=='__main__':
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);print(server.server_port,flush=True);server.serve_forever()
