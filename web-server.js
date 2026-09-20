import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
http.createServer((request,response) => { const urlPath=new URL(request.url,'http://localhost').pathname; const file=path.resolve(root,'.'+(urlPath==='/'?'/index.html':urlPath)); if(!file.startsWith(root)){response.writeHead(403);return response.end();} fs.readFile(file,(error,data)=>{if(error){response.writeHead(404);return response.end('Not found');}response.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store, max-age=0, must-revalidate','Pragma':'no-cache'});response.end(data);}); }).listen(4173,'127.0.0.1',()=>console.log('HHBA UI listening at http://127.0.0.1:4173'));
