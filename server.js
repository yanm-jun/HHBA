const http = require('http');
const { randomUUID } = require('crypto');
const checks = new Map();
const send = (res, status, body) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'http://127.0.0.1:4173','Access-Control-Allow-Headers':'Content-Type, X-HHBA-Approval-Token'}); res.end(JSON.stringify(body)); };
const readJson = request => new Promise((resolve, reject) => { let raw=''; request.on('data', chunk => { raw+=chunk; if(raw.length>100000) request.destroy(); }); request.on('end', () => { try { resolve(JSON.parse(raw||'{}')); } catch { reject(new Error('Request body must be valid JSON.')); } }); });
http.createServer(async (request,response) => {
  if(request.method==='OPTIONS') return send(response,204,{});
  if(request.method==='GET'&&request.url==='/health') return send(response,200,{status:'ok',service:'hhba-reality-api'});
  if(request.method==='POST'&&request.url==='/api/reality-checks/draft') { try { const {question,location}=await readJson(request); if(!question||!location)return send(response,400,{error:'question and location are required'}); const id=`proposal_${randomUUID().slice(0,8)}`; checks.set(id,{id,question,location,status:'DRAFT'}); return send(response,201,{id,status:'DRAFT',sampleSize:3,budget:{min:150,max:300,currency:'CNY'}}); } catch(error) { return send(response,400,{error:error.message}); } }
  const match=request.url.match(/^\/api\/reality-checks\/([^/]+)\/(approval|publish)$/);
  if(request.method==='POST'&&match) { const [,id,action]=match; const check=checks.get(id); if(!check)return send(response,404,{error:'proposal not found'}); if(action==='approval') { check.approvalToken=`hhba_appr_${randomUUID()}`;check.status='AWAITING_USER_APPROVAL';return send(response,201,{approvalToken:check.approvalToken,expiresInSeconds:900}); } if(request.headers['x-hhba-approval-token']!==check.approvalToken)return send(response,403,{error:'a valid backend-issued approval token is required'});check.status='DISPATCHING';check.realityCheckId=`rc_${randomUUID().slice(0,8)}`;return send(response,201,{realityCheckId:check.realityCheckId,status:check.status}); }
  return send(response,404,{error:'not found'});
}).listen(8787,'127.0.0.1',()=>console.log('HHBA API listening at http://127.0.0.1:8787'));
