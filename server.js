'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
fs.mkdirSync(DATA, { recursive: true });

const projects = new Map();
const streams = new Map();
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon' };
const idPattern = /^[A-Za-z0-9_-]{6,40}$/;
const limit = (v,min,max) => Math.min(max,Math.max(min,Number(v)||min));
const str = (v,len=100) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,len);
const isId = v => typeof v === 'string' && idPattern.test(v);
const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body); };
const emptyFrame = id => ({ id, strokes:[] });
const MAX_IMAGE_DATA = 1_600_000;
const imageDataRe = /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/;

function projectFile(id) { return path.join(DATA,`${id}.json`); }
function load(id) {
  if (projects.has(id)) return projects.get(id);
  try { const p=JSON.parse(fs.readFileSync(projectFile(id),'utf8')); if (!Array.isArray(p.frames)) return null; p.width=p.width||960;p.height=p.height||540; projects.set(id,p); return p; } catch { return null; }
}
function save(p) {
  // Synchronous atomic replacement: all operations in this single process remain ordered.
  const target=projectFile(p.id), temp=`${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(p)); fs.renameSync(temp,target);
}
function send(res,type,data) { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
function broadcast(id,type,data) { for (const client of streams.get(id) || []) send(client.res,type,data); }
function presence(id) {
  const clients=[...(streams.get(id)||[])].map(c=>({id:c.id,name:c.name,color:c.color}));
  broadcast(id,'presence',{clients});
}
function normalizeStroke(input,p) {
  if (!input || !isId(input.id)) return null;
  const opacity=limit(input.opacity??1,0.001,1);
  if (input.kind==='image') {
    if (typeof input.src!=='string'||input.src.length>MAX_IMAGE_DATA||!imageDataRe.test(input.src)) return null;
    return {id:input.id,kind:'image',role:input.role==='fill'?'fill':'image',src:input.src,x:limit(input.x??0,0,p.width),y:limit(input.y??0,0,p.height),w:limit(input.w??p.width,1,p.width*2),h:limit(input.h??p.height,1,p.height*2),opacity};
  }
  if (!['pen','eraser'].includes(input.tool)) return null;
  if (!Array.isArray(input.points) || !input.points.length || input.points.length>2000) return null;
  const points = input.points.map(pt => [Math.round(limit(pt[0],0,p.width)*10)/10,Math.round(limit(pt[1],0,p.height)*10)/10]);
  const color = /^#[a-fA-F0-9]{6}$/.test(input.color) ? input.color : '#26223b';
  return {id:input.id,tool:input.tool,color,size:limit(input.size,1,80),points,opacity};
}
function normalizeFrame(input,p) {
  if (!input || !isId(input.id) || !Array.isArray(input.strokes) || input.strokes.length>2000) return null;
  const strokes=[];
  for (const item of input.strokes) { const stroke=normalizeStroke(item,p); if (!stroke) return null; strokes.push(stroke); }
  return {id:input.id,strokes};
}
function operate(p,op) {
  if (!op || typeof op.type !== 'string') return {error:'Invalid operation'};
  const idx=p.frames.findIndex(f=>f.id===op.frameId);
  switch(op.type) {
    case 'stroke-add': {
      const stroke=normalizeStroke(op.stroke,p);
      if (idx<0 || !stroke || p.frames[idx].strokes.length>=2000) return {error:'Invalid stroke'};
      if (p.frames[idx].strokes.some(s=>s.id===stroke.id)) return {error:'Duplicate stroke'};
      p.frames[idx].strokes.push(stroke); return {type:'stroke-add',frameId:op.frameId,stroke};
    }
    case 'stroke-insert': {
      const stroke=normalizeStroke(op.stroke,p);
      if(idx<0 || !stroke || p.frames[idx].strokes.length>=2000 || p.frames[idx].strokes.some(s=>s.id===stroke.id)) return {error:'Invalid stroke insertion'};
      const at=Math.max(0,Math.min(p.frames[idx].strokes.length,Math.floor(Number(op.index)||0)));
      p.frames[idx].strokes.splice(at,0,stroke);return {type:'stroke-insert',frameId:op.frameId,stroke,index:at};
    }
    case 'stroke-batch-update': {
      if(idx<0 || !Array.isArray(op.strokes) || !op.strokes.length || op.strokes.length>2000) return {error:'Invalid stroke update'};
      const updates=[];
      for(const item of op.strokes) {
        const stroke=normalizeStroke(item,p);
        if(!stroke || !p.frames[idx].strokes.some(s=>s.id===stroke.id) || updates.some(s=>s.id===stroke.id)) return {error:'Unknown stroke in batch'};
        updates.push(stroke);
      }
      for(const stroke of updates) {
        const at=p.frames[idx].strokes.findIndex(s=>s.id===stroke.id);
        p.frames[idx].strokes[at]=stroke;
      }
      return {type:'stroke-batch-update',frameId:op.frameId,strokes:updates};
    }
    case 'frame-replace': {
      if(idx<0 || !Array.isArray(op.strokes) || op.strokes.length>2000) return {error:'Invalid frame replacement'};
      const all=op.strokes.map(s=>normalizeStroke(s,p));
      if(all.some(s=>!s))return {error:'Invalid frame content'};
      p.frames[idx].strokes=all;return {type:'frame-replace',frameId:op.frameId,strokes:all};
    }
    case 'frame-insert-batch': {
      if(!Array.isArray(op.frames)||!op.frames.length||op.frames.length>24||p.frames.length+op.frames.length>120) return {error:'Too many tween frames'};
      const frames=op.frames.map(f=>normalizeFrame(f,p));
      if(frames.some(f=>!f)||new Set(frames.map(f=>f.id)).size!==frames.length||frames.some(f=>p.frames.some(ex=>ex.id===f.id)))return {error:'Invalid tween frames'};
      const at=p.frames.findIndex(f=>f.id===op.afterId);
      p.frames.splice(at<0?p.frames.length:at+1,0,...frames);
      return {type:'frame-insert-batch',afterId:op.afterId,frames};
    }
    case 'frame-delete-batch': {
      if(!Array.isArray(op.frameIds)||!op.frameIds.length||p.frames.length<=op.frameIds.length)return {error:'Invalid frame IDs'};
      const ids=new Set(op.frameIds);
      if(ids.size!==op.frameIds.length||[...ids].some(id=>!p.frames.some(f=>f.id===id)))return {error:'Missing tween frame'};
      p.frames=p.frames.filter(f=>!ids.has(f.id));return {type:'frame-delete-batch',frameIds:[...ids]};
    }
    case 'stroke-remove': {
      if (idx<0 || !isId(op.strokeId)) return {error:'Invalid stroke'};
      const i=p.frames[idx].strokes.findIndex(s=>s.id===op.strokeId);
      if(i<0) return {error:'Stroke not found'};
      p.frames[idx].strokes.splice(i,1); return {type:'stroke-remove',frameId:op.frameId,strokeId:op.strokeId};
    }
    case 'frame-add': {
      const frame=normalizeFrame(op.frame,p);
      if(!frame || p.frames.length>=120 || p.frames.some(f=>f.id===frame.id)) return {error:'Invalid new frame'};
      const after=p.frames.findIndex(f=>f.id===op.afterId);
      p.frames.splice(after<0?p.frames.length:after+1,0,frame);
      return {type:'frame-add',frame,afterId:op.afterId};
    }
    case 'frame-delete': {
      if(idx<0 || p.frames.length===1) return {error:'Cannot delete last frame'};
      p.frames.splice(idx,1); return {type:'frame-delete',frameId:op.frameId};
    }
    case 'frame-move': {
      if(idx<0) return {error:'Frame not found'};
      const target=Math.max(0,Math.min(p.frames.length-1,Math.floor(Number(op.targetIndex)||0)));
      p.frames.splice(target,0,p.frames.splice(idx,1)[0]);
      return {type:'frame-move',frameId:op.frameId,targetIndex:target};
    }
    case 'frame-clear': {
      if(idx<0) return {error:'Frame not found'};
      p.frames[idx].strokes=[]; return {type:'frame-clear',frameId:op.frameId};
    }
    case 'canvas-resize': {
      const width=Number(op.width),height=Number(op.height);
      if(!Number.isInteger(width)||!Number.isInteger(height)||width<128||height<128||width>1920||height>1920)return {error:'Canvas dimensions must be between 128 and 1920 pixels'};
      const oldWidth=p.width,oldHeight=p.height;
      if(oldWidth===width && oldHeight===height)return {type:'canvas-resize',oldWidth,oldHeight,width,height};
      const scale=Math.min(width/oldWidth,height/oldHeight),offsetX=(width-oldWidth*scale)/2,offsetY=(height-oldHeight*scale)/2;
      const round=n=>Math.round(n*10)/10;
      for(const frame of p.frames){
        for(const stroke of frame.strokes){
          if(stroke.kind==='image'){
            stroke.x=round(stroke.x*scale+offsetX);stroke.y=round(stroke.y*scale+offsetY);
            stroke.w=round(stroke.w*scale);stroke.h=round(stroke.h*scale);
          }else{
            stroke.size=Math.min(80,Math.max(1,Math.round(stroke.size*scale*100)/100));
            stroke.points=stroke.points.map(([x,y])=>[round(x*scale+offsetX),round(y*scale+offsetY)]);
          }
        }
      }
      p.width=width;p.height=height;
      return {type:'canvas-resize',oldWidth,oldHeight,width,height};
    }
    case 'fps-set': p.fps=Math.round(limit(op.fps,1,24)); return {type:'fps-set',fps:p.fps};
    case 'title-set': p.title=str(op.title,80).trim()||'Untitled animation'; return {type:'title-set',title:p.title};
    default: return {error:'Unknown operation'};
  }
}
function readBody(req,max=400_000) {
  return new Promise((resolve,reject)=>{
    let body='',size=0;
    req.on('data',chunk=>{ size+=chunk.length; if(size>max){reject(new Error('Payload too large')); req.destroy();} else body+=chunk; });
    req.on('end',()=>{try{resolve(JSON.parse(body||'{}'));}catch{reject(new Error('Invalid JSON'));}});
    req.on('error',reject);
  });
}
function staticFile(req,res,urlPath) {
  const requested=urlPath==='/'?'/index.html':urlPath;
  const file=path.resolve(PUBLIC,'.'+requested);
  if (file!==path.join(PUBLIC,'index.html') && !file.startsWith(PUBLIC+path.sep)) return json(res,403,{error:'Forbidden'});
  try {
    const stat=fs.statSync(file);
    if (!stat.isFile()) throw new Error();
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Length':stat.size});
    fs.createReadStream(file).pipe(res);
  } catch { json(res,404,{error:'Not found'}); }
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const route=url.pathname;
  try {
    if (route==='/api/projects' && req.method==='POST') {
      const body=await readBody(req,10000);
      const id=crypto.randomBytes(5).toString('hex');
      const p={id,title:str(body.title||'Untitled animation',80),width:960,height:540,fps:8,frames:[emptyFrame(crypto.randomUUID())],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      save(p);projects.set(id,p);return json(res,201,{project:p});
    }
    const m=route.match(/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(events|ops|draft))?$/);
    if(m) {
      const [,id,action]=m, p=load(id);
      if(!p) return json(res,404,{error:'Project not found'});
      if(!action && req.method==='GET') return json(res,200,{project:p});
      if(action==='events' && req.method==='GET') {
        const clientId=str(url.searchParams.get('client'),50),name=str(url.searchParams.get('name')||'Guest',22).trim()||'Guest';
        const color=/^#[a-f0-9]{6}$/i.test(url.searchParams.get('color')||'')?url.searchParams.get('color'):'#a78bfa';
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
        res.write(': connected\n\n');
        const client={res,id:clientId,name,color};
        if (!streams.has(id))streams.set(id,new Set());streams.get(id).add(client);
        send(res,'snapshot',{project:p}); presence(id);
        req.on('close',()=>{streams.get(id)?.delete(client);presence(id);});
        return;
      }
      if(action==='ops' && req.method==='POST') {
        const body=await readBody(req,12_000_000);
        const op=operate(p,body.op);
        if(op.error)return json(res,400,{error:op.error});
        p.updatedAt=new Date().toISOString();save(p);
        broadcast(id,'op',{op,clientId:str(body.clientId,60),opId:str(body.opId,60)});
        return json(res,200,{ok:true});
      }
      if(action==='draft' && req.method==='POST') {
        const b=await readBody(req,16000);
        if(!isId(b.frameId))return json(res,400,{error:'Invalid frame'});
        const points=Array.isArray(b.points)?b.points.slice(-120).map(pt=>[limit(pt[0],0,p.width),limit(pt[1],0,p.height)]):[];
        const tool=['pen','eraser'].includes(b.tool)?b.tool:'pen';
        broadcast(id,'draft',{clientId:str(b.clientId,60),frameId:b.frameId,points,tool,size:limit(b.size,1,80),color:/^#[a-fA-F0-9]{6}$/.test(b.color)?b.color:'#222222',end:!!b.end});
        return json(res,200,{ok:true});
      }
      return json(res,405,{error:'Method not allowed'});
    }
    if(req.method==='GET')return staticFile(req,res,route);
    json(res,404,{error:'Not found'});
  } catch(err) { if(!res.headersSent)json(res,500,{error:err.message||'Server error'}); }
});
setInterval(()=>{for(const s of streams.values())for(const c of s)try{c.res.write(': ping\n\n')}catch{}},20_000).unref();
server.listen(PORT,HOST,()=>console.log(`Flipbook Studio running at http://localhost:${PORT}`));
