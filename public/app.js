(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const uid = () => {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);crypto.getRandomValues(bytes);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  const safeText = value => String(value??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const TWO = n=>String(n).padStart(2,'0');
  const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const clientId=uid();
  const clientColor=['#b49bff','#8fe0cf','#f5ab7c','#e8b2d0','#8bb9f0'][Math.floor(Math.random()*5)];
  let name=(()=>{try{return sessionStorage.getItem('flipbook-name')}catch{return null}})()||`Artist ${Math.floor(Math.random()*900+100)}`;
  let project=null, activeFrameId=null, eventSource=null, online=[];
  let tool='pen', color='#252139', brushSize=8, onion=true, playing=false, playInterval=null;
  let pointerId=null, localDraft=null, exportBusy=false, lastDraftAt=0;
  let onionPrev=1,onionNext=0,lassoDraft=null,selection=null,moveDraft=null;
  let undoStack=[],redoStack=[],historyBusy=false;
  const touchPointers=new Map();let touchGesture=null;
  const imageCache=new Map();
  let toastTimeout=0, draggedId=null, renderedCanvasSize='';
  const remoteDrafts=new Map();
  const drawCanvas=$('drawCanvas'), drawCtx=drawCanvas.getContext('2d');
  const scratch=document.createElement('canvas');scratch.width=960;scratch.height=540;
  const canvasSizePresets=['960x540','1280x720','1920x1080','800x600','800x800','1080x1080','720x1280'];
  const dimensions=()=>({width:project?.width||960,height:project?.height||540});
  const scratchCtx=scratch.getContext('2d');

  function toast(msg) {
    const el=$('toast');el.textContent=msg;el.classList.add('show');
    clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('show'),2600);
  }
  function errorMessage(err) { toast(err?.message||'Something went wrong');console.error(err); }
  function showLanding() { $('loading').hidden=true;$('landing').hidden=false;$('app').hidden=true; }
  function showApp() { $('loading').hidden=true;$('landing').hidden=true;$('app').hidden=false; }
  async function request(url,options={}) {
    const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    let data;try{data=await response.json();}catch{throw new Error('Invalid server response');}
    if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);
    return data;
  }
  async function createProject(){
    $('newProject').disabled=true;
    try{ const {project:p}=await request('/api/projects',{method:'POST',body:JSON.stringify({title:'My first flipbook'})});location.href=`/?p=${encodeURIComponent(p.id)}`; }
    catch(e){errorMessage(e);$('newProject').disabled=false;}
  }
  function activeFrame(){return project?.frames.find(f=>f.id===activeFrameId)||project?.frames[0];}
  function indexOfFrame(){return project?.frames.findIndex(f=>f.id===activeFrameId)??0;}

  function imageFor(src){
    if(!imageCache.has(src)) {
      const im=new Image();imageCache.set(src,im);
      im.onload=()=>{renderCanvas();if(project)renderTimeline()};
      im.onerror=()=>toast('An imported image could not be loaded');
      im.src=src;
    }
    return imageCache.get(src);
  }
  async function waitForImages(frames){
    const sources=new Set(frames.flatMap(f=>f.strokes.filter(s=>s.kind==='image').map(s=>s.src)));
    await Promise.all([...sources].map(src=>new Promise((resolve,reject)=>{
      const im=imageFor(src);if(im.complete){return im.naturalWidth?resolve():reject(new Error('Image could not be decoded'));}
      im.addEventListener('load',resolve,{once:true});im.addEventListener('error',()=>reject(new Error('Image could not be decoded')),{once:true});
    })));
  }
  function paintPath(ctx, stroke) {
    ctx.save();ctx.globalAlpha=stroke.opacity??1;
    if(stroke.kind==='image'){
      const im=imageFor(stroke.src);
      if(im.complete && im.naturalWidth)ctx.drawImage(im,stroke.x,stroke.y,stroke.w,stroke.h);
      ctx.restore();return;
    }
    const points=stroke.points;
    if(!points?.length){ctx.restore();return;}
    ctx.globalCompositeOperation=stroke.tool==='eraser'?'destination-out':'source-over';
    ctx.strokeStyle=stroke.tool==='eraser'?'#000000':stroke.color;
    ctx.fillStyle=ctx.strokeStyle;
    ctx.lineWidth=stroke.size;ctx.lineCap='round';ctx.lineJoin='round';
    if(points.length===1){ctx.beginPath();ctx.arc(points[0][0],points[0][1],Math.max(.5,stroke.size/2),0,Math.PI*2);ctx.fill();}
    else{ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.stroke();}
    ctx.restore();
  }
  function paintFrameOn(ctx,frame,width=dimensions().width,height=dimensions().height,{drafts=[],background='#ffffff'}={}) {
    ctx.save();ctx.clearRect(0,0,width,height);ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
    const layer=document.createElement('canvas');layer.width=width;layer.height=height;
    const layerCtx=layer.getContext('2d');layerCtx.scale(width/dimensions().width,height/dimensions().height);
    for(const stroke of (frame?.strokes||[]))paintPath(layerCtx,stroke);
    for(const draft of drafts)paintPath(layerCtx,draft);
    ctx.drawImage(layer,0,0);ctx.restore();
  }
  function moveStroke(stroke,dx,dy){
    const {width,height}=dimensions();
    if(stroke.kind==='image')return {...stroke,x:Math.max(0,Math.min(width,stroke.x+dx)),y:Math.max(0,Math.min(height,stroke.y+dy))};
    return {...stroke,points:stroke.points.map(p=>[Math.max(0,Math.min(width,p[0]+dx)),Math.max(0,Math.min(height,p[1]+dy))])};
  }
  function resizeStroke(stroke,oldWidth,oldHeight,newWidth,newHeight){
    const scale=Math.min(newWidth/oldWidth,newHeight/oldHeight);
    const offsetX=(newWidth-oldWidth*scale)/2,offsetY=(newHeight-oldHeight*scale)/2;
    const round=n=>Math.round(n*10)/10;
    if(stroke.kind==='image')return {...stroke,x:round(stroke.x*scale+offsetX),y:round(stroke.y*scale+offsetY),w:round(stroke.w*scale),h:round(stroke.h*scale)};
    return {...stroke,size:Math.min(80,Math.max(1,Math.round(stroke.size*scale*100)/100)),points:stroke.points.map(([x,y])=>[round(x*scale+offsetX),round(y*scale+offsetY)])};
  }
  function updateCanvasDimensions(){
    if(!project)return;
    const {width,height}=dimensions();
    if(drawCanvas.width!==width || drawCanvas.height!==height){drawCanvas.width=width;drawCanvas.height=height;}
    if(scratch.width!==width || scratch.height!==height){scratch.width=width;scratch.height=height;}
    $('artboardWrap').style.setProperty('--canvas-aspect',String(width/height));
    $('canvasResolution').textContent=`${width} × ${height}`;
    const key=`${width}x${height}`;
    if(key!==renderedCanvasSize){
      renderedCanvasSize=key;
      $('canvasWidth').value=width;$('canvasHeight').value=height;
      $('canvasPreset').value=canvasSizePresets.includes(key)?key:'custom';
      $('customCanvasSize').hidden=$('canvasPreset').value!=='custom';
      $('applyCanvasSize').disabled=true;
    }
  }
  function closeCanvasSizePanel(){
    $('canvasSizePanel').hidden=true;
    $('canvasSizeToggle').setAttribute('aria-expanded','false');
  }
  function desiredCanvasSize(){
    const preset=$('canvasPreset').value;
    const [w,h]=preset==='custom'?[Number($('canvasWidth').value),Number($('canvasHeight').value)]:preset.split('x').map(Number);
    return {width:w,height:h};
  }
  function updateCanvasSizeForm(){
    const preset=$('canvasPreset').value;
    $('customCanvasSize').hidden=preset!=='custom';
    if(preset==='custom' && !Number($('canvasWidth').value))$('canvasWidth').value=dimensions().width;
    if(preset==='custom' && !Number($('canvasHeight').value))$('canvasHeight').value=dimensions().height;
    const {width,height}=desiredCanvasSize();
    const valid=Number.isInteger(width)&&Number.isInteger(height)&&width>=128&&height>=128&&width<=1920&&height<=1920;
    $('applyCanvasSize').disabled=!valid||(width===dimensions().width&&height===dimensions().height);
  }
  async function applyCanvasSize(){
    const {width,height}=desiredCanvasSize();
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<128||height<128||width>1920||height>1920){toast('Choose a width and height between 128 and 1920 pixels');return;}
    if(width===dimensions().width&&height===dimensions().height)return;
    if(project.frames.some(frame=>frame.strokes.length)){
      const ok=await confirmAction('Resize all animation frames?',`Resize from ${dimensions().width} × ${dimensions().height} to ${width} × ${height}? Artwork will be scaled to fit and centered in every frame for all collaborators.`);
      if(!ok)return;
    }
    stopPlay();selection=null;localDraft=null;moveDraft=null;lassoDraft=null;
    $('applyCanvasSize').disabled=true;
    const ok=await postOp({type:'canvas-resize',width,height});
    if(ok){closeCanvasSizePanel();toast(`Canvas resized to ${width} × ${height}`);}
    else updateCanvasSizeForm();
  }
  function editedPreview(frame){
    if(!moveDraft || !selection || selection.frameId!==frame?.id)return frame;
    const ids=selection.ids;
    return {...frame,strokes:frame.strokes.map(s=>ids.has(s.id)?moveStroke(s,moveDraft.dx,moveDraft.dy):s)};
  }
  function makeLayer(frame,drafts=[]) {
    scratchCtx.clearRect(0,0,scratch.width,scratch.height);
    for(const stroke of (frame?.strokes||[]))paintPath(scratchCtx,stroke);
    for(const draft of drafts)paintPath(scratchCtx,draft);
    return scratch;
  }
  function selectedBounds(frame){
    if(!selection||selection.frameId!==frame?.id)return null;
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    for(const s of frame.strokes.filter(s=>selection.ids.has(s.id))){
      const pts=s.kind==='image'?[[s.x,s.y],[s.x+s.w,s.y+s.h]]:s.points;
      for(const [x,y] of pts){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
    }
    return Number.isFinite(left)?{left,top,right,bottom}:null;
  }
  function updateSelectionUI(){const valid=!!(selection&&selection.frameId===activeFrameId&&selection.ids.size);$('selectionActions').hidden=!valid;}
  function overlaySelection(){
    drawCtx.save();drawCtx.lineWidth=2;drawCtx.setLineDash([8,5]);drawCtx.strokeStyle='#7560cf';
    if(lassoDraft?.length){drawCtx.beginPath();drawCtx.moveTo(...lassoDraft[0]);for(const p of lassoDraft.slice(1))drawCtx.lineTo(...p);drawCtx.stroke();}
    if(selection?.frameId===activeFrameId){
      const bounds=selectedBounds(activeFrame());if(bounds){
        const dx=moveDraft?.dx||0,dy=moveDraft?.dy||0;
        drawCtx.strokeRect(bounds.left-6+dx,bounds.top-6+dy,bounds.right-bounds.left+12,bounds.bottom-bounds.top+12);
      }
    }
    drawCtx.restore();
  }
  function renderCanvas(){
    if(!project)return;
    drawCtx.save();drawCtx.fillStyle='#ffffff';drawCtx.fillRect(0,0,drawCanvas.width,drawCanvas.height);
    const idx=indexOfFrame();
    if(onion && !playing){
      for(let d=onionPrev;d>=1;d--){
        const f=project.frames[idx-d];if(!f)continue;
        makeLayer(f);drawCtx.globalAlpha=.27/(.55+d*.45);drawCtx.drawImage(scratch,0,0);drawCtx.globalAlpha=1;
      }
      for(let d=onionNext;d>=1;d--){
        const f=project.frames[idx+d];if(!f)continue;
        makeLayer(f);drawCtx.globalAlpha=.19/(.55+d*.45);drawCtx.drawImage(scratch,0,0);drawCtx.globalAlpha=1;
      }
    }
    const drafts=[];
    if(localDraft && !playing)drafts.push(localDraft);
    for(const [id,draft] of remoteDrafts)if(id!==clientId && draft.frameId===activeFrameId && !playing)drafts.push(draft);
    makeLayer(editedPreview(activeFrame()),drafts);drawCtx.drawImage(scratch,0,0);
    if(!playing)overlaySelection();
    drawCtx.restore();
  }
  function renderFrameInfo(){
    const n=Math.max(0,indexOfFrame())+1,count=project.frames.length;
    $('currentFrameNum').textContent=TWO(n);$('totalFrames').textContent=TWO(count);
    $('frameCounter').textContent=`${TWO(n)} / ${TWO(count)}`;
    $('timelineCount').textContent=`${count} frame${count===1?'':'s'}`;
    $('fpsSelect').value=String(project.fps);
    $('deleteFrameBtn').disabled=count<=1;
    $('addFrameBtn').disabled=count>=120;
    $('duplicateFrameBtn').disabled=count>=120;
  }
  function renderTimeline(){
    if(!project)return;
    const strip=$('frameStrip');strip.textContent='';
    const {width,height}=dimensions();
    const thumbScale=Math.min(308/width,174/height);
    const thumbWidth=Math.max(1,Math.round(width*thumbScale)),thumbHeight=Math.max(1,Math.round(height*thumbScale));
    project.frames.forEach((frame,i)=>{
      const item=document.createElement('div');item.className=`frame-item${frame.id===activeFrameId?' selected':''}`;
      item.tabIndex=0;item.draggable=true;item.dataset.frameId=frame.id;item.title=`Frame ${i+1} · click to select; drag to reorder`;
      const thumbWrap=document.createElement('div');thumbWrap.className='frame-thumb-wrap';
      const canvas=document.createElement('canvas');canvas.width=thumbWidth;canvas.height=thumbHeight;
      paintFrameOn(canvas.getContext('2d'),frame,thumbWidth,thumbHeight);
      const index=document.createElement('div');index.className='frame-index';index.textContent=TWO(i+1);
      thumbWrap.append(canvas,index);
      const bottom=document.createElement('div');bottom.className='frame-bottom';
      const label=document.createElement('span');label.textContent=`Frame ${TWO(i+1)}`;
      const strokes=document.createElement('span');strokes.textContent=frame.strokes.length?`${frame.strokes.length} strokes`:'Blank';
      bottom.append(label,strokes);item.append(thumbWrap,bottom);
      item.addEventListener('click',()=>selectFrame(frame.id));
      item.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();selectFrame(frame.id)}});
      item.addEventListener('contextmenu',e=>{e.preventDefault();selectFrame(frame.id);duplicateFrame()});
      item.addEventListener('dragstart',e=>{draggedId=frame.id;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',frame.id);});
      item.addEventListener('dragover',e=>{e.preventDefault();item.classList.add('drag-over');});
      item.addEventListener('dragleave',()=>item.classList.remove('drag-over'));
      item.addEventListener('drop',e=>{e.preventDefault();item.classList.remove('drag-over');const from=draggedId;if(from && from!==frame.id)postOp({type:'frame-move',frameId:from,targetIndex:i});draggedId=null;});
      item.addEventListener('dragend',()=>{draggedId=null;document.querySelectorAll('.drag-over').forEach(el=>el.classList.remove('drag-over'));});
      strip.append(item);
    });
    const add=document.createElement('button');add.className='frame-add-inline';add.innerHTML='<svg class="ui-icon"><use href="#i-plus"/></svg> Add frame';add.title='Add blank frame after selection';add.onclick=addFrame;add.disabled=project.frames.length>=120;strip.append(add);
    renderFrameInfo();
  }
  function updateSelectionOnly(){
    document.querySelectorAll('.frame-item').forEach(el=>el.classList.toggle('selected',el.dataset.frameId===activeFrameId));
    renderFrameInfo();updateSelectionUI();renderCanvas();
  }
  function selectFrame(id){
    if(!project.frames.some(f=>f.id===id))return;
    stopPlay();activeFrameId=id;localDraft=null;selection=null;lassoDraft=null;moveDraft=null;updateSelectionOnly();
    const selected=[...document.querySelectorAll('.frame-item')].find(el=>el.dataset.frameId===id);
    selected?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});
  }
  function syncUI(){
    if(!project.frames.some(f=>f.id===activeFrameId))activeFrameId=project.frames[Math.max(0,Math.min(project.frames.length-1,indexOfFrame()))]?.id||project.frames[0]?.id;
    if(document.activeElement!==$('projectTitle'))$('projectTitle').value=project.title;
    updateCanvasDimensions();renderTimeline();updateSelectionUI();renderCanvas();
  }
  function applyOp(op,sender){
    if(!project)return;
    const frame=project.frames.find(f=>f.id===op.frameId),idx=project.frames.findIndex(f=>f.id===op.frameId);
    switch(op.type){
      case 'stroke-add': if(frame && !frame.strokes.some(s=>s.id===op.stroke.id))frame.strokes.push(op.stroke);remoteDrafts.delete(sender);if(sender===clientId)localDraft=null;break;
      case 'stroke-remove': if(frame)frame.strokes=frame.strokes.filter(s=>s.id!==op.strokeId);break;
      case 'stroke-insert': if(frame&&!frame.strokes.some(s=>s.id===op.stroke.id))frame.strokes.splice(op.index,0,op.stroke);break;
      case 'stroke-batch-update':if(frame)for(const s of op.strokes){const ix=frame.strokes.findIndex(old=>old.id===s.id);if(ix>=0)frame.strokes[ix]=s;}break;
      case 'frame-replace':if(frame)frame.strokes=op.strokes;break;
      case 'frame-insert-batch':{
        const at=project.frames.findIndex(f=>f.id===op.afterId);
        const existing=new Set(project.frames.map(f=>f.id));
        const incoming=op.frames.filter(f=>!existing.has(f.id));
        project.frames.splice(at<0?project.frames.length:at+1,0,...incoming);
        if(sender===clientId&&incoming.length)activeFrameId=incoming[0].id;break;
      }
      case 'frame-delete-batch':{
        const ids=new Set(op.frameIds);project.frames=project.frames.filter(f=>!ids.has(f.id));
        if(ids.has(activeFrameId))activeFrameId=project.frames[0]?.id;break;
      }
      case 'frame-add': {
        if(project.frames.some(f=>f.id===op.frame.id))break;
        const after=project.frames.findIndex(f=>f.id===op.afterId);
        project.frames.splice(after<0?project.frames.length:after+1,0,op.frame);
        if(sender===clientId)activeFrameId=op.frame.id;
        break;
      }
      case 'frame-delete': {
        if(idx>=0){project.frames.splice(idx,1);if(activeFrameId===op.frameId)activeFrameId=project.frames[Math.max(0,idx-1)]?.id||project.frames[0]?.id;}
        break;
      }
      case 'frame-move':{
        if(idx>=0)project.frames.splice(op.targetIndex,0,project.frames.splice(idx,1)[0]);break;
      }
      case 'frame-clear': if(frame)frame.strokes=[];break;
      case 'canvas-resize': {
        const oldWidth=op.oldWidth||dimensions().width,oldHeight=op.oldHeight||dimensions().height;
        for(const f of project.frames)f.strokes=f.strokes.map(s=>resizeStroke(s,oldWidth,oldHeight,op.width,op.height));
        project.width=op.width;project.height=op.height;
        selection=null;localDraft=null;moveDraft=null;lassoDraft=null;
        undoStack=[];redoStack=[];updateHistoryUI();
        break;
      }
      case 'fps-set':project.fps=op.fps;if(playing){stopPlay();startPlay()}break;
      case 'title-set':project.title=op.title;break;
    }
    syncUI();
  }
  async function postOp(op,history=null){
    if(!project)return;
    $('saveState').innerHTML='<span class="live-dot"></span> Saving…';
    try{ await request(`/api/projects/${project.id}/ops`,{method:'POST',body:JSON.stringify({clientId,opId:uid(),op})});$('saveState').innerHTML='<span class="live-dot"></span> Live sync';
      if(history){undoStack.push(history);if(undoStack.length>100)undoStack.shift();redoStack=[];updateHistoryUI();}
      return true;
    }
    catch(err){errorMessage(err);await reloadProject();return false;}
  }
  async function reloadProject(){
    if(!project)return;
    try{const {project:p}=await request(`/api/projects/${project.id}`);project=p;remoteDrafts.clear();syncUI();}
    catch(err){errorMessage(err)}
  }
  function connect(){
    if(eventSource)eventSource.close();
    const url=`/api/projects/${project.id}/events?client=${encodeURIComponent(clientId)}&name=${encodeURIComponent(name)}&color=${encodeURIComponent(clientColor)}`;
    eventSource=new EventSource(url);
    eventSource.addEventListener('snapshot',e=>{
      const p=JSON.parse(e.data).project;
      if(p.id!==project.id)return;
      project=p;syncUI();$('saveState').innerHTML='<span class="live-dot"></span> Live sync';
    });
    eventSource.addEventListener('op',e=>{const data=JSON.parse(e.data);applyOp(data.op,data.clientId)});
    eventSource.addEventListener('presence',e=>{online=JSON.parse(e.data).clients;renderPresence()});
    eventSource.addEventListener('draft',e=>{
      const d=JSON.parse(e.data);if(d.clientId===clientId)return;
      if(d.end)remoteDrafts.delete(d.clientId);
      else remoteDrafts.set(d.clientId,d);
      if(d.frameId===activeFrameId)renderCanvas();
    });
    eventSource.onerror=()=>{$('saveState').innerHTML='<span class="live-dot" style="background:#eab76b"></span> Reconnecting…'};
  }
  function renderPresence(){
    const seen=new Map();for(const client of online)seen.set(client.id,client);
    $('collaborators').innerHTML=[...seen.values()].slice(0,5).map(c=>`<span class="avatar" title="${safeText(c.name)}" style="background:${c.color}">${safeText(c.name.trim().slice(0,1).toUpperCase()||'?')}</span>`).join('');
    $('onlineCount').textContent=`${seen.size} online`;
  }
  function pointerPoint(e){
    const rect=drawCanvas.getBoundingClientRect();
    return [Math.max(0,Math.min(dimensions().width,((e.clientX-rect.left)/rect.width)*dimensions().width)),Math.max(0,Math.min(dimensions().height,((e.clientY-rect.top)/rect.height)*dimensions().height))];
  }
  function sendDraft(end=false){
    if(!project)return;
    const draft=localDraft;
    const payload={clientId,frameId:activeFrameId,points:end?[]:(draft?.points.slice(-120)||[]),tool,color,size:brushSize,end};
    fetch(`/api/projects/${project.id}/draft`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
  }
  function updateHistoryUI(){
    $('undoBtn').disabled=!undoStack.length||historyBusy;
    $('redoBtn').disabled=!redoStack.length||historyBusy;
  }
  async function undo(){
    if(historyBusy||!undoStack.length)return;
    historyBusy=true;updateHistoryUI();const entry=undoStack.pop();
    const ok=await postOp(entry.undo);
    if(ok)redoStack.push(entry);else undoStack.push(entry);
    historyBusy=false;updateHistoryUI();
  }
  async function redo(){
    if(historyBusy||!redoStack.length)return;
    historyBusy=true;updateHistoryUI();const entry=redoStack.pop();
    const ok=await postOp(entry.redo);
    if(ok)undoStack.push(entry);else redoStack.push(entry);
    historyBusy=false;updateHistoryUI();
  }
  function historyInsert(frameId,stroke,index=null){
    const redo=index===null?{type:'stroke-add',frameId,stroke}:{type:'stroke-insert',frameId,stroke,index};
    return {undo:{type:'stroke-remove',frameId,strokeId:stroke.id},redo};
  }
  function pointInside(point,poly){
    let inside=false;const [x,y]=point;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  }
  function segmentCrosses(a,b,c,d){
    const orient=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
    const u=orient(a,b,c),v=orient(a,b,d),w=orient(c,d,a),z=orient(c,d,b);
    return ((u>0)!==(v>0)) && ((w>0)!==(z>0));
  }
  function pathCrossesPolygon(points,poly){
    for(let i=1;i<points.length;i++)for(let j=0;j<poly.length;j++)if(segmentCrosses(points[i-1],points[i],poly[j],poly[(j+1)%poly.length]))return true;
    return false;
  }
  function finishLasso(){
    const polygon=lassoDraft;lassoDraft=null;
    if(!polygon||polygon.length<3){renderCanvas();return;}
    const chosen=[];
    for(const stroke of activeFrame().strokes){
      if(stroke.kind==='image'){
        const pts=[[stroke.x,stroke.y],[stroke.x+stroke.w,stroke.y],[stroke.x+stroke.w,stroke.y+stroke.h],[stroke.x,stroke.y+stroke.h],[stroke.x+stroke.w/2,stroke.y+stroke.h/2]];
        if(pts.some(pt=>pointInside(pt,polygon)) || polygon.some(pt=>pt[0]>=stroke.x&&pt[0]<=stroke.x+stroke.w&&pt[1]>=stroke.y&&pt[1]<=stroke.y+stroke.h))chosen.push(stroke.id);
      }else if(stroke.points.some(pt=>pointInside(pt,polygon)) || pathCrossesPolygon(stroke.points,polygon))chosen.push(stroke.id);
    }
    selection=chosen.length?{frameId:activeFrameId,ids:new Set(chosen)}:null;
    updateSelectionUI();renderCanvas();
    if(chosen.length)toast(`${chosen.length} element${chosen.length===1?'':'s'} selected — drag to move`);
  }
  function startTouch(e){
    if(e.pointerType!=='touch')return false;
    const now=performance.now(),pt=[e.clientX,e.clientY];
    if(!touchGesture||!touchPointers.size)touchGesture={start:now,max:0,moved:false};
    touchPointers.set(e.pointerId,{start:pt,last:pt});
    touchGesture.max=Math.max(touchGesture.max,touchPointers.size);
    if(touchGesture.max>=2){
      if(localDraft)sendDraft(true);
      localDraft=null;pointerId=null;lassoDraft=null;moveDraft=null;renderCanvas();
      return true;
    }
    return false;
  }
  function moveTouch(e){
    const t=touchPointers.get(e.pointerId);
    if(!t)return false;
    t.last=[e.clientX,e.clientY];
    if(Math.hypot(t.last[0]-t.start[0],t.last[1]-t.start[1])>14)touchGesture.moved=true;
    return touchGesture.max>=2;
  }
  function endTouch(e){
    if(e.pointerType!=='touch')return false;
    const isGesture=touchGesture?.max>=2;
    touchPointers.delete(e.pointerId);
    if(!touchPointers.size){
      if(isGesture && !touchGesture.moved && performance.now()-touchGesture.start<450 && e.type!=='pointercancel'){
        if(touchGesture.max===2)undo();else if(touchGesture.max===3)redo();
      }
      touchGesture=null;
    }
    return isGesture;
  }
  function pointerDown(e){
    if(exportBusy || e.button!==0 || !project)return;
    if(playing)stopPlay();
    e.preventDefault();try{drawCanvas.setPointerCapture(e.pointerId)}catch{}
    if(startTouch(e))return;
    pointerId=e.pointerId;
    const p=pointerPoint(e);
    if(tool==='bucket'){pointerId=null;bucketFill(p);return;}
    if(tool==='lasso'){
      const b=selectedBounds(activeFrame());
      if(b&&p[0]>=b.left-10&&p[0]<=b.right+10&&p[1]>=b.top-10&&p[1]<=b.bottom+10){moveDraft={start:p,dx:0,dy:0};}
      else{selection=null;updateSelectionUI();lassoDraft=[p];}
      renderCanvas();return;
    }
    localDraft={id:uid(),tool,color,size:brushSize,points:[p],opacity:1};
    lastDraftAt=0;renderCanvas();sendDraft();
  }
  function pointerMove(e){
    if(moveTouch(e))return;
    if(pointerId!==e.pointerId)return;
    const p=pointerPoint(e);
    if(tool==='lasso'){
      if(moveDraft){moveDraft.dx=p[0]-moveDraft.start[0];moveDraft.dy=p[1]-moveDraft.start[1];}
      else if(lassoDraft&&lassoDraft.length<2000){const prev=lassoDraft.at(-1);if(Math.hypot(p[0]-prev[0],p[1]-prev[1])>2)lassoDraft.push(p);}
      renderCanvas();return;
    }
    if(!localDraft)return;
    const points=localDraft.points,prev=points[points.length-1];
    if(Math.hypot(p[0]-prev[0],p[1]-prev[1])<.6)return;
    if(points.length<2000)points.push(p);
    renderCanvas();
    if(performance.now()-lastDraftAt>90){lastDraftAt=performance.now();sendDraft();}
  }
  function pointerUp(e){
    const gesture=endTouch(e);
    try{drawCanvas.releasePointerCapture(e.pointerId)}catch{}
    if(gesture || pointerId!==e.pointerId)return;
    pointerId=null;
    if(e.type==='pointercancel'){localDraft=null;lassoDraft=null;moveDraft=null;sendDraft(true);renderCanvas();return;}
    if(tool==='lasso'){
      if(lassoDraft)finishLasso();
      else if(moveDraft&&selection){
        const {dx,dy}=moveDraft;moveDraft=null;
        if(Math.hypot(dx,dy)>1){
          const prev=activeFrame().strokes.filter(s=>selection.ids.has(s.id));
          const next=prev.map(s=>moveStroke(s,dx,dy));
          const frameId=activeFrameId;
          postOp({type:'stroke-batch-update',frameId,strokes:next},{undo:{type:'stroke-batch-update',frameId,strokes:prev},redo:{type:'stroke-batch-update',frameId,strokes:next}});
        }
        renderCanvas();
      }
      return;
    }
    if(!localDraft)return;
    const completed=localDraft,frameId=activeFrameId;sendDraft(true);
    postOp({type:'stroke-add',frameId,stroke:completed},historyInsert(frameId,completed));
  }
  function setTool(next){
    tool=next;document.querySelectorAll('.tool-button').forEach(el=>el.classList.toggle('is-active',el.dataset.tool===tool));
    drawCanvas.style.cursor=tool==='eraser'?'cell':tool==='lasso'?'move':tool==='bucket'?'copy':'crosshair';
    if(tool!=='lasso'){selection=null;lassoDraft=null;moveDraft=null;updateSelectionUI();renderCanvas();}
  }
  function setColor(next){color=next;if(tool==='eraser'||tool==='lasso')setTool('pen');$('colorCode').textContent=color.toUpperCase();$('colorPicker').value=color;document.querySelectorAll('.color-swatch').forEach(el=>el.classList.toggle('selected',el.dataset.color.toLowerCase()===color.toLowerCase()))}
  function setBrushSize(next){brushSize=Number(next);$('brushSize').value=brushSize;$('brushSizeValue').textContent=`${brushSize} px`;$('brushPreviewDot').style.width=`${Math.min(48,brushSize)}px`;$('brushPreviewDot').style.height=`${Math.min(48,brushSize)}px`}
  async function bucketFill(p){
    const frame=activeFrame();if(!frame)return;
    const buffer=document.createElement('canvas');buffer.width=dimensions().width;buffer.height=dimensions().height;
    const ctx=buffer.getContext('2d',{willReadFrequently:true});paintFrameOn(ctx,frame);
    const {width:w,height:h}=dimensions();const pixels=ctx.getImageData(0,0,w,h).data;
    const x=Math.floor(Math.min(w-1,p[0])),y=Math.floor(Math.min(h-1,p[1]));
    const start=(y*w+x),base=start*4,seed=[pixels[base],pixels[base+1],pixels[base+2]];
    const hex=color.slice(1),rgb=[parseInt(hex.slice(0,2),16),parseInt(hex.slice(2,4),16),parseInt(hex.slice(4,6),16)];
    const result=new ImageData(w,h),visited=new Uint8Array(w*h),queue=new Int32Array(w*h);
    let head=0,tail=1;queue[0]=start;visited[start]=1;
    const matches=i=>{const o=i*4;return Math.max(Math.abs(pixels[o]-seed[0]),Math.abs(pixels[o+1]-seed[1]),Math.abs(pixels[o+2]-seed[2]))<=32};
    let count=0;
    while(head<tail){
      const i=queue[head++];if(!matches(i))continue;
      const o=i*4;result.data[o]=rgb[0];result.data[o+1]=rgb[1];result.data[o+2]=rgb[2];result.data[o+3]=255;count++;
      const xx=i%w;
      for(const n of [xx?i-1:-1,xx<w-1?i+1:-1,i>=w?i-w:-1,i<w*(h-1)?i+w:-1])if(n>=0&&!visited[n]){visited[n]=1;queue[tail++]=n;}
    }
    if(!count){toast('No fillable area found');return;}
    const mask=document.createElement('canvas');mask.width=w;mask.height=h;
    mask.getContext('2d').putImageData(result,0,0);
    const src=mask.toDataURL('image/png');
    if(src.length>1_600_000){toast('Fill is too complex to save; try a simpler area');return;}
    const stroke={id:uid(),kind:'image',role:'fill',src,x:0,y:0,w,h,opacity:1};
    const frameId=frame.id;
    await postOp({type:'stroke-add',frameId,stroke},historyInsert(frameId,stroke));
  }
  async function importImages(files){
    if(!project)return;
    for(const file of [...files].slice(0,8)){
      if(!file.type.startsWith('image/')){toast('Please choose an image file');continue;}
      try{
        const source=URL.createObjectURL(file),im=new Image();
        await new Promise((resolve,reject)=>{im.onload=resolve;im.onerror=reject;im.src=source;});
        const scale=Math.min(dimensions().width*.88/im.naturalWidth,dimensions().height*.87/im.naturalHeight,1);
        const w=Math.max(1,Math.round(im.naturalWidth*scale)),h=Math.max(1,Math.round(im.naturalHeight*scale));
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        canvas.getContext('2d').drawImage(im,0,0,w,h);URL.revokeObjectURL(source);
        let src=canvas.toDataURL('image/webp',.88);
        if(!src.startsWith('data:image/webp'))src=canvas.toDataURL('image/png');
        if(src.length>1_600_000)throw new Error('Image too large after compression');
        const frameId=activeFrameId,stroke={id:uid(),kind:'image',role:'image',src,x:Math.round((dimensions().width-w)/2),y:Math.round((dimensions().height-h)/2),w,h,opacity:1};
        await postOp({type:'stroke-add',frameId,stroke},historyInsert(frameId,stroke));
        toast('Image added — use Lasso to move it');
      }catch(err){errorMessage(err);}
    }
    $('imageInput').value='';
  }
  function addFrame(){if(project.frames.length>=120)return toast('Maximum 120 frames');postOp({type:'frame-add',afterId:activeFrameId,frame:{id:uid(),strokes:[]}})}
  function duplicateFrame(){
    if(project.frames.length>=120)return toast('Maximum 120 frames');
    const src=activeFrame();if(!src)return;
    const strokes=src.strokes.map(s=>({...s,id:uid(),...(s.points?{points:s.points.map(p=>[...p])}:{})}));
    postOp({type:'frame-add',afterId:activeFrameId,frame:{id:uid(),strokes}});
  }
  function confirmAction(title,message){
    const d=$('confirmDialog');$('dialogTitle').textContent=title;$('dialogMessage').textContent=message;
    return new Promise(resolve=>{d.addEventListener('close',()=>resolve(d.returnValue==='confirm'),{once:true});d.showModal()});
  }
  async function deleteFrame(){if(project.frames.length<=1)return;const yes=await confirmAction('Delete this frame?','This removes the drawing on the selected frame for everyone.');if(yes)postOp({type:'frame-delete',frameId:activeFrameId})}
  async function clearFrame(){
    const frame=activeFrame();if(!frame?.strokes.length)return;
    const yes=await confirmAction('Clear this frame?','Every element on this frame will be removed for everyone.');
    if(yes){const frameId=frame.id,old=structuredClone(frame.strokes);selection=null;updateSelectionUI();
      postOp({type:'frame-replace',frameId,strokes:[]},{undo:{type:'frame-replace',frameId,strokes:old},redo:{type:'frame-replace',frameId,strokes:[]}});
    }
  }
  function deleteSelection(){
    const frame=activeFrame();if(!selection||!frame||selection.frameId!==frame.id)return;
    const old=structuredClone(frame.strokes),removeIds=selection.ids;
    const next=old.filter(s=>!removeIds.has(s.id));selection=null;updateSelectionUI();
    postOp({type:'frame-replace',frameId:frame.id,strokes:next},{undo:{type:'frame-replace',frameId:frame.id,strokes:old},redo:{type:'frame-replace',frameId:frame.id,strokes:next}});
  }
  function duplicateSelection(){
    const frame=activeFrame();if(!selection||!frame||selection.frameId!==frame.id)return;
    const chosen=frame.strokes.filter(s=>selection.ids.has(s.id));
    const copies=chosen.map(s=>moveStroke({...s,id:uid()},20,20));
    const prev=structuredClone(frame.strokes),next=[...prev,...copies];
    selection={frameId:frame.id,ids:new Set(copies.map(s=>s.id))};updateSelectionUI();
    postOp({type:'frame-replace',frameId:frame.id,strokes:next},{undo:{type:'frame-replace',frameId:frame.id,strokes:prev},redo:{type:'frame-replace',frameId:frame.id,strokes:next}});
  }
  function goFrame(delta){const ix=indexOfFrame(),next=Math.max(0,Math.min(project.frames.length-1,ix+delta));selectFrame(project.frames[next].id)}
  function stopPlay(){playing=false;clearInterval(playInterval);playInterval=null;$('playBtn').innerHTML='<svg class="ui-icon"><use href="#i-play"/></svg>';renderCanvas()}
  function startPlay(){
    if(!project?.frames.length)return;
    playing=true;localDraft=null;
    $('playBtn').innerHTML='<svg class="ui-icon"><use href="#i-pause"/></svg>';
    playInterval=setInterval(()=>{
      const next=(indexOfFrame()+1)%project.frames.length;
      activeFrameId=project.frames[next].id;renderFrameInfo();renderCanvas();
      document.querySelectorAll('.frame-item').forEach(el=>el.classList.toggle('selected',el.dataset.frameId===activeFrameId));
    },1000/project.fps);
  }
  function togglePlay(){if(playing)stopPlay();else startPlay()}
  async function copyInvite(){
    const link=new URL('/',location.href);link.searchParams.set('p',project.id);
    try{await navigator.clipboard.writeText(link.href);toast('Invite link copied — share it with friends!')}
    catch{window.prompt('Copy the invite link:',link.href)}
  }
  // DOTween Ease enum values exposed in the editor. The default Back overshoot is 1.70158;
  // Flash uses three flashes so its oscillation is useful when baking in-between frames.
  function evaluateEase(name,t){
    if(t<=0)return 0;
    if(t>=1)return 1;
    if(name==='Unset')name='InOutQuad';
    if(name==='Linear')return t;
    if(['Flash','InFlash','OutFlash','InOutFlash'].includes(name)){
      const flashes=3;
      const step=Math.min(flashes-1,Math.floor(t*flashes));
      let phase=t*flashes-step;
      if(step%2)phase=1-phase;
      if(name==='InFlash')return phase*phase;
      if(name==='OutFlash')return 1-(1-phase)*(1-phase);
      if(name==='InOutFlash')return phase<.5?2*phase*phase:1-2*(1-phase)*(1-phase);
      return phase;
    }
    const kind=name.startsWith('InOut')?'InOut':name.startsWith('Out')?'Out':'In';
    const family=name.slice(kind.length);
    const n=({Quad:2,Cubic:3,Quart:4,Quint:5})[family];
    if(n){
      if(kind==='In')return t**n;
      if(kind==='Out')return 1-(1-t)**n;
      return t<.5?(2*t)**n/2:1-(-2*t+2)**n/2;
    }
    if(family==='Sine'){
      if(kind==='In')return 1-Math.cos(t*Math.PI/2);
      if(kind==='Out')return Math.sin(t*Math.PI/2);
      return -(Math.cos(Math.PI*t)-1)/2;
    }
    if(family==='Expo'){
      if(kind==='In')return 2**(10*t-10);
      if(kind==='Out')return 1-2**(-10*t);
      return t<.5?2**(20*t-10)/2:(2-2**(-20*t+10))/2;
    }
    if(family==='Circ'){
      if(kind==='In')return 1-Math.sqrt(Math.max(0,1-t*t));
      if(kind==='Out')return Math.sqrt(Math.max(0,1-(t-1)**2));
      return t<.5?(1-Math.sqrt(Math.max(0,1-(2*t)**2)))/2:(Math.sqrt(Math.max(0,1-(-2*t+2)**2))+1)/2;
    }
    if(family==='Back'){
      const s=1.70158;
      if(kind==='In')return (s+1)*t*t*t-s*t*t;
      if(kind==='Out')return 1+(s+1)*(t-1)**3+s*(t-1)**2;
      const s2=s*1.525;
      return t<.5?(2*t)**2*((s2+1)*2*t-s2)/2:((2*t-2)**2*((s2+1)*(2*t-2)+s2)+2)/2;
    }
    if(family==='Elastic'){
      const twoPi=Math.PI*2;
      // DOTween's standard default amplitude is 1.70158 (not the typical Penner amplitude 1).
      const amp=1.70158;
      if(kind==='InOut'){
        const period=.45,phase=period/twoPi*Math.asin(1/amp);
        const q=2*t-1;
        return q<0?-.5*amp*(2**(10*q))*Math.sin((q-phase)*twoPi/period):1+.5*amp*(2**(-10*q))*Math.sin((q-phase)*twoPi/period);
      }
      const period=.3,phase=period/twoPi*Math.asin(1/amp);
      return kind==='In'?-amp*(2**(10*(t-1)))*Math.sin((t-1-phase)*twoPi/period):1+amp*(2**(-10*t))*Math.sin((t-phase)*twoPi/period);
    }
    if(family==='Bounce'){
      const out=x=>{
        const c=7.5625,d=2.75;
        if(x<1/d)return c*x*x;
        if(x<2/d){x-=1.5/d;return c*x*x+.75;}
        if(x<2.5/d){x-=2.25/d;return c*x*x+.9375;}
        x-=2.625/d;return c*x*x+.984375;
      };
      if(kind==='In')return 1-out(1-t);
      if(kind==='Out')return out(t);
      return t<.5?(1-out(1-2*t))/2:(1+out(2*t-1))/2;
    }
    return t;
  }
  function updateCurve(){
    const name=$('tweenEase').value;
    const pts=Array.from({length:121},(_,i)=>{
      const t=i/120,value=evaluateEase(name,t);
      return `${i?'L':'M'} ${(10+140*t).toFixed(2)} ${(90-80*value).toFixed(2)}`;
    });
    $('curvePreview').innerHTML=`<path d="M10 90 H150 M10 10 V90" fill="none" stroke="#41465d" stroke-width="1.2"/><path d="M10 50 H150" stroke="#34394e" stroke-dasharray="3 4" fill="none"/><path d="${pts.join(' ')}" stroke="#b7a0ff" stroke-width="2.7" stroke-linejoin="round" stroke-linecap="round" fill="none"/>`;
    $('curveHint').textContent=name.endsWith('Flash')?'Three flashes · default weight':name==='Unset'?'DOTween default · InOutQuad':`DOTween Ease.${name}`;
  }
  function resample(points,n){
    if(points.length===1)return Array.from({length:n},()=>[...points[0]]);
    const segments=[0];let total=0;
    for(let i=1;i<points.length;i++){total+=Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]);segments.push(total);}
    if(total<.00001)return Array.from({length:n},()=>[...points[0]]);
    let segment=1;
    return Array.from({length:n},(_,i)=>{
      const dist=i/(n-1)*total;while(segment<segments.length-1&&segments[segment]<dist)segment++;
      const a=points[segment-1],b=points[segment],frac=(dist-segments[segment-1])/Math.max(.00001,segments[segment]-segments[segment-1]);
      return [a[0]+(b[0]-a[0])*frac,a[1]+(b[1]-a[1])*frac];
    });
  }
  function colorLerp(a,b,t){
    const channels=x=>[1,3,5].map(i=>parseInt(x.slice(i,i+2),16));
    const A=channels(a),B=channels(b);
    return '#'+A.map((v,i)=>Math.max(0,Math.min(255,Math.round(v+(B[i]-v)*t))).toString(16).padStart(2,'0')).join('');
  }
  function normalizeTweenStroke(stroke){
    const {width,height}=dimensions();
    const bound=(v,min,max)=>Math.max(min,Math.min(max,v));
    const opacity=bound(stroke.opacity??1,0.001,1);
    if(stroke.kind==='image')return {...stroke,opacity,x:bound(stroke.x,0,width),y:bound(stroke.y,0,height),w:bound(stroke.w,1,width*2),h:bound(stroke.h,1,height*2)};
    return {...stroke,opacity,size:bound(stroke.size,1,80),points:stroke.points.map(([x,y])=>[bound(x,0,width),bound(y,0,height)])};
  }
  function interpolatePair(a,b,t){
    if(!a && !b)return [];
    if(!a)return [{...b,id:uid(),opacity:(b.opacity??1)*t}];
    if(!b)return [{...a,id:uid(),opacity:(a.opacity??1)*(1-t)}];
    if(a.kind==='image'&&b.kind==='image'&&a.src===b.src)return [{...a,id:uid(),x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,w:a.w+(b.w-a.w)*t,h:a.h+(b.h-a.h)*t,opacity:(a.opacity??1)*(1-t)+(b.opacity??1)*t}];
    if(a.tool&&b.tool&&a.tool===b.tool){
      const n=Math.min(400,Math.max(12,a.points.length,b.points.length));
      const A=resample(a.points,n),B=resample(b.points,n);
      return [{id:uid(),tool:a.tool,color:colorLerp(a.color,b.color,t),size:a.size+(b.size-a.size)*t,opacity:(a.opacity??1)*(1-t)+(b.opacity??1)*t,points:A.map((p,i)=>[p[0]+(B[i][0]-p[0])*t,p[1]+(B[i][1]-p[1])*t])}];
    }
    return [{...a,id:uid(),opacity:(a.opacity??1)*(1-t)},{...b,id:uid(),opacity:(b.opacity??1)*t}];
  }
  function generateTweens(){
    const i=indexOfFrame(),from=project.frames[i],to=project.frames[i+1],count=Number($('tweenCount').value);
    if(!to){toast('Select a keyframe that has a following frame');return;}
    if(project.frames.length+count>120){toast('Not enough room: maximum 120 frames');return;}
    if(!from.strokes.length&&!to.strokes.length){toast('Draw something in your keyframes first');return;}
    const ease=$('tweenEase').value;
    const frames=Array.from({length:count},(_,j)=>{
      const t=evaluateEase(ease,(j+1)/(count+1));
      const strokes=[];for(let k=0;k<Math.max(from.strokes.length,to.strokes.length);k++)strokes.push(...interpolatePair(from.strokes[k],to.strokes[k],t).map(normalizeTweenStroke));
      return {id:uid(),strokes};
    });
    const frameIds=frames.map(f=>f.id),afterId=from.id;
    postOp({type:'frame-insert-batch',afterId,frames},{undo:{type:'frame-delete-batch',frameIds},redo:{type:'frame-insert-batch',afterId,frames}});
  }
  function baseFilename(){return (project.title||'animation').replace(/[^\w\d _-]+/g,'').trim().replace(/\s+/g,'-').slice(0,60)||'animation'}
  function download(blob,filename){
    const url=URL.createObjectURL(blob),anchor=document.createElement('a');
    anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60_000);
  }
  function paintExportFrame(ctx,frame){paintFrameOn(ctx,frame,ctx.canvas.width,ctx.canvas.height)}
  async function recordVideo(frames,fps,format,label){
    if(!('MediaRecorder' in window)||!HTMLCanvasElement.prototype.captureStream)throw new Error('Video recording requires Chrome, Edge, Firefox or Safari');
    const types=format==='mp4'?['video/mp4;codecs=avc1.42E01E','video/mp4']:['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
    const supported=types.find(t=>MediaRecorder.isTypeSupported(t));
    if(!supported)throw new Error(`${format.toUpperCase()} recording is not supported in this browser. Try WebM or GIF.`);
    const canvas=document.createElement('canvas');canvas.width=dimensions().width;canvas.height=dimensions().height;
    const ctx=canvas.getContext('2d',{alpha:false});
    paintExportFrame(ctx,frames[0]);
    const stream=canvas.captureStream(Math.max(30,fps));let recorder;
    try{
      recorder=new MediaRecorder(stream,{mimeType:supported,videoBitsPerSecond:3_000_000});
      const parts=[];recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};
      const finished=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||new Error('Recording failed'))});
      recorder.start(100);
      const loops=Math.max(1,Math.ceil((1.5*fps)/frames.length));
      const total=loops*frames.length,delay=1000/fps;
      for(let i=0;i<total;i++){
        const start=performance.now();paintExportFrame(ctx,frames[i%frames.length]);
        label.textContent=`Exporting ${Math.round((i+1)/total*100)}%`;
        await sleep(Math.max(0,delay-(performance.now()-start)));
      }
      await sleep(130);recorder.stop();await finished;
      const blob=new Blob(parts,{type:supported});if(!blob.size)throw new Error('The video is empty');
      return blob;
    }finally{if(recorder?.state==='recording')recorder.stop();stream.getTracks().forEach(t=>t.stop());}
  }
  async function exportAnimation(){
    if(exportBusy||!project)return;
    exportBusy=true;stopPlay();
    const button=$('exportBtn'),label=button.querySelector('span'),format=$('exportFormat').value;
    button.disabled=true;label.textContent='Exporting…';
    const frames=structuredClone(project.frames),fps=project.fps;
    try{
      await waitForImages(frames);
      let blob,ext;
      if(format==='webm'||format==='mp4'){blob=await recordVideo(frames,fps,format,label);ext=format;}
      else{
        const encoder=window.FlipbookExport;
        if(!encoder)throw new Error('Exporter library did not load');
        const update=n=>{label.textContent=`Exporting ${n}%`};
        const paint=(ctx,frame,width,height)=>paintFrameOn(ctx,frame,width,height);
        paint.canvasSize={width:dimensions().width,height:dimensions().height};
        if(format==='gif'){blob=await encoder.gif(frames,fps,paint,update);ext='gif';}
        else if(format==='pngzip'){blob=await encoder.zipPng(frames,paint,update);ext='zip';}
        else if(format==='sheet'){blob=await encoder.sheet(frames,paint,update);ext='png';}
      }
      download(blob,`${baseFilename()}${format==='sheet'?'-spritesheet':format==='pngzip'?'-frames':''}.${ext}`);
      toast(`Exported ${ext.toUpperCase()} successfully`);
    }catch(err){errorMessage(err)}
    finally{exportBusy=false;button.disabled=false;label.textContent='Export'}
  }
  function bindUI(){
    $('newProject').addEventListener('click',createProject);
    document.querySelectorAll('.tool-button').forEach(el=>el.addEventListener('click',()=>setTool(el.dataset.tool)));
    document.querySelectorAll('.color-swatch').forEach(el=>el.addEventListener('click',()=>setColor(el.dataset.color)));
    $('colorPicker').addEventListener('input',e=>setColor(e.target.value));
    $('brushSize').addEventListener('input',e=>setBrushSize(e.target.value));
    $('undoBtn').addEventListener('click',undo);$('redoBtn').addEventListener('click',redo);$('clearFrameBtn').addEventListener('click',clearFrame);
    $('importImageBtn').addEventListener('click',()=>$('imageInput').click());
    $('imageInput').addEventListener('change',e=>importImages(e.target.files));
    $('deleteSelectionBtn').addEventListener('click',deleteSelection);
    $('duplicateSelectionBtn').addEventListener('click',duplicateSelection);
    $('deselectBtn').addEventListener('click',()=>{selection=null;updateSelectionUI();renderCanvas()});
    for(const id of ['onionPrev','onionNext'])$(id).addEventListener('change',()=>{onionPrev=Number($('onionPrev').value);onionNext=Number($('onionNext').value);renderCanvas()});
    $('tweenEase').addEventListener('change',updateCurve);
    $('tweenBtn').addEventListener('click',generateTweens);updateCurve();updateHistoryUI();
    $('onionToggle').addEventListener('change',e=>{onion=e.target.checked;renderCanvas()});
    $('canvasSizeToggle').addEventListener('click',()=>{
      const panel=$('canvasSizePanel'),open=panel.hidden;
      panel.hidden=!open;$('canvasSizeToggle').setAttribute('aria-expanded',String(open));
      if(open){renderedCanvasSize='';updateCanvasDimensions();updateCanvasSizeForm();}
    });
    document.addEventListener('pointerdown',e=>{
      if(!$('canvasSizeMenu').contains(e.target))closeCanvasSizePanel();
    });
    $('canvasPreset').addEventListener('change',updateCanvasSizeForm);
    $('canvasWidth').addEventListener('input',updateCanvasSizeForm);
    $('canvasHeight').addEventListener('input',updateCanvasSizeForm);
    $('applyCanvasSize').addEventListener('click',applyCanvasSize);
    $('fpsSelect').addEventListener('change',e=>postOp({type:'fps-set',fps:Number(e.target.value)}));
    $('projectTitle').addEventListener('change',e=>postOp({type:'title-set',title:e.target.value}));
    $('projectTitle').addEventListener('keydown',e=>{if(e.key==='Enter')e.target.blur()});
    $('inviteBtn').addEventListener('click',copyInvite);
    $('exportBtn').addEventListener('click',exportAnimation);
    $('playBtn').addEventListener('click',togglePlay);
    $('prevFrameBtn').addEventListener('click',()=>goFrame(-1));$('nextFrameBtn').addEventListener('click',()=>goFrame(1));
    $('firstFrameBtn').addEventListener('click',()=>selectFrame(project.frames[0].id));$('lastFrameBtn').addEventListener('click',()=>selectFrame(project.frames.at(-1).id));
    $('addFrameBtn').addEventListener('click',addFrame);$('duplicateFrameBtn').addEventListener('click',duplicateFrame);$('deleteFrameBtn').addEventListener('click',deleteFrame);
    drawCanvas.addEventListener('pointerdown',pointerDown);drawCanvas.addEventListener('pointermove',pointerMove);
    drawCanvas.addEventListener('pointerup',pointerUp);drawCanvas.addEventListener('pointercancel',pointerUp);
    drawCanvas.addEventListener('contextmenu',e=>e.preventDefault());
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape' && !$('canvasSizePanel').hidden){e.preventDefault();closeCanvasSizePanel();return;}
      if(!project || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)||$('confirmDialog').open)return;
      if((e.ctrlKey||e.metaKey)&&((e.shiftKey&&e.key.toLowerCase()==='z')||e.key.toLowerCase()==='y')){e.preventDefault();redo();return;}
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();return;}
      if(e.key===' '){e.preventDefault();togglePlay()}
      else if(e.key==='ArrowLeft'){e.preventDefault();goFrame(-1)}
      else if(e.key==='ArrowRight'){e.preventDefault();goFrame(1)}
      else if(e.key.toLowerCase()==='b')setTool('pen');
      else if(e.key.toLowerCase()==='e')setTool('eraser');
      else if(e.key.toLowerCase()==='g')setTool('bucket');
      else if(e.key.toLowerCase()==='l')setTool('lasso');
      else if((e.key==='Delete'||e.key==='Backspace')&&selection){e.preventDefault();deleteSelection();}
      else if(e.key==='Escape'){closeCanvasSizePanel();selection=null;updateSelectionUI();renderCanvas()}
    });
    window.addEventListener('beforeunload',()=>eventSource?.close());
    setBrushSize(8);
  }
  async function init(){
    bindUI();const id=new URLSearchParams(location.search).get('p');
    if(!id){showLanding();return;}
    try{
      const {project:p}=await request(`/api/projects/${encodeURIComponent(id)}`);
      project=p;activeFrameId=p.frames[0]?.id;
      showApp();syncUI();connect();
    }catch(err){showLanding();toast('This flipbook could not be found. Create a new one!');}
  }
  init();
})();
