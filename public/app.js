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
  let toastTimeout=0, draggedId=null;
  const remoteDrafts=new Map();
  const drawCanvas=$('drawCanvas'), drawCtx=drawCanvas.getContext('2d');
  const scratch=document.createElement('canvas');scratch.width=960;scratch.height=540;
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

  function paintPath(ctx, stroke) {
    const points=stroke.points;
    if(!points?.length)return;
    ctx.save();
    ctx.globalCompositeOperation=stroke.tool==='eraser'?'destination-out':'source-over';
    ctx.strokeStyle=stroke.tool==='eraser'?'#000000':stroke.color;
    ctx.fillStyle=ctx.strokeStyle;
    ctx.lineWidth=stroke.size;ctx.lineCap='round';ctx.lineJoin='round';
    if(points.length===1){ctx.beginPath();ctx.arc(points[0][0],points[0][1],Math.max(.5,stroke.size/2),0,Math.PI*2);ctx.fill();}
    else{ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);for(let i=1;i<points.length;i++)ctx.lineTo(points[i][0],points[i][1]);ctx.stroke();}
    ctx.restore();
  }
  function paintFrameOn(ctx,frame,width=960,height=540,{drafts=[],background='#ffffff'}={}) {
    ctx.save();ctx.clearRect(0,0,width,height);ctx.fillStyle=background;ctx.fillRect(0,0,width,height);
    const layer=document.createElement('canvas');layer.width=width;layer.height=height;
    const layerCtx=layer.getContext('2d');layerCtx.scale(width/960,height/540);
    for(const stroke of (frame?.strokes||[]))paintPath(layerCtx,stroke);
    for(const draft of drafts)paintPath(layerCtx,draft);
    ctx.drawImage(layer,0,0);ctx.restore();
  }
  function makeLayer(frame,drafts=[]) {
    scratchCtx.clearRect(0,0,960,540);
    for(const stroke of (frame?.strokes||[]))paintPath(scratchCtx,stroke);
    for(const draft of drafts)paintPath(scratchCtx,draft);
    return scratch;
  }
  function renderCanvas(){
    if(!project)return;
    drawCtx.save();drawCtx.fillStyle='#ffffff';drawCtx.fillRect(0,0,960,540);
    const idx=indexOfFrame();
    if(onion && idx>0 && !playing){
      makeLayer(project.frames[idx-1]);drawCtx.globalAlpha=.22;drawCtx.drawImage(scratch,0,0);drawCtx.globalAlpha=1;
    }
    const drafts=[];
    if(localDraft && !playing)drafts.push(localDraft);
    for(const [id,draft] of remoteDrafts)if(id!==clientId && draft.frameId===activeFrameId && !playing)drafts.push(draft);
    makeLayer(activeFrame(),drafts);drawCtx.drawImage(scratch,0,0);
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
    project.frames.forEach((frame,i)=>{
      const item=document.createElement('div');item.className=`frame-item${frame.id===activeFrameId?' selected':''}`;
      item.tabIndex=0;item.draggable=true;item.dataset.frameId=frame.id;item.title=`Frame ${i+1} · click to select; drag to reorder`;
      const thumbWrap=document.createElement('div');thumbWrap.className='frame-thumb-wrap';
      const canvas=document.createElement('canvas');canvas.width=308;canvas.height=174;
      paintFrameOn(canvas.getContext('2d'),frame,308,174);
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
    renderFrameInfo();renderCanvas();
  }
  function selectFrame(id){
    if(!project.frames.some(f=>f.id===id))return;
    stopPlay();activeFrameId=id;localDraft=null;updateSelectionOnly();
    const selected=[...document.querySelectorAll('.frame-item')].find(el=>el.dataset.frameId===id);
    selected?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});
  }
  function syncUI(){
    if(!project.frames.some(f=>f.id===activeFrameId))activeFrameId=project.frames[Math.max(0,Math.min(project.frames.length-1,indexOfFrame()))]?.id||project.frames[0]?.id;
    if(document.activeElement!==$('projectTitle'))$('projectTitle').value=project.title;
    renderTimeline();renderCanvas();
  }
  function applyOp(op,sender){
    if(!project)return;
    const frame=project.frames.find(f=>f.id===op.frameId),idx=project.frames.findIndex(f=>f.id===op.frameId);
    switch(op.type){
      case 'stroke-add': if(frame && !frame.strokes.some(s=>s.id===op.stroke.id))frame.strokes.push(op.stroke);remoteDrafts.delete(sender);if(sender===clientId)localDraft=null;break;
      case 'stroke-remove': if(frame)frame.strokes=frame.strokes.filter(s=>s.id!==op.strokeId);break;
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
      case 'fps-set':project.fps=op.fps;if(playing){stopPlay();startPlay()}break;
      case 'title-set':project.title=op.title;break;
    }
    syncUI();
  }
  async function postOp(op){
    if(!project)return;
    $('saveState').innerHTML='<span class="live-dot"></span> Saving…';
    try{ await request(`/api/projects/${project.id}/ops`,{method:'POST',body:JSON.stringify({clientId,opId:uid(),op})});$('saveState').innerHTML='<span class="live-dot"></span> Live sync'; }
    catch(err){errorMessage(err);await reloadProject();}
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
    return [Math.max(0,Math.min(960,((e.clientX-rect.left)/rect.width)*960)),Math.max(0,Math.min(540,((e.clientY-rect.top)/rect.height)*540))];
  }
  function sendDraft(end=false){
    if(!project)return;
    const draft=localDraft;
    const payload={clientId,frameId:activeFrameId,points:end?[]:(draft?.points.slice(-120)||[]),tool,color,size:brushSize,end};
    fetch(`/api/projects/${project.id}/draft`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).catch(()=>{});
  }
  function pointerDown(e){
    if(exportBusy || e.button!==0 || !project)return;
    if(playing)stopPlay();
    e.preventDefault();pointerId=e.pointerId;drawCanvas.setPointerCapture(e.pointerId);
    localDraft={id:uid(),tool,color,size:brushSize,points:[pointerPoint(e)]};
    lastDraftAt=0;renderCanvas();sendDraft();
  }
  function pointerMove(e){
    if(pointerId!==e.pointerId||!localDraft)return;
    const p=pointerPoint(e),points=localDraft.points,prev=points[points.length-1];
    if(Math.hypot(p[0]-prev[0],p[1]-prev[1])<.6)return;
    if(points.length<2000)points.push(p);
    renderCanvas();
    if(performance.now()-lastDraftAt>90){lastDraftAt=performance.now();sendDraft();}
  }
  function pointerUp(e){
    if(pointerId!==e.pointerId || !localDraft)return;
    pointerId=null;
    try{drawCanvas.releasePointerCapture(e.pointerId)}catch{}
    const completed=localDraft;sendDraft(true);
    // Keep local preview visible until the server confirms and broadcasts the new stroke.
    postOp({type:'stroke-add',frameId:activeFrameId,stroke:completed});
  }
  function setTool(next){tool=next;document.querySelectorAll('.tool-button').forEach(el=>el.classList.toggle('is-active',el.dataset.tool===tool));drawCanvas.style.cursor=tool==='eraser'?'cell':'crosshair'}
  function setColor(next){color=next;setTool('pen');$('colorCode').textContent=color.toUpperCase();$('colorPicker').value=color;document.querySelectorAll('.color-swatch').forEach(el=>el.classList.toggle('selected',el.dataset.color.toLowerCase()===color.toLowerCase()))}
  function setBrushSize(next){brushSize=Number(next);$('brushSize').value=brushSize;$('brushSizeValue').textContent=`${brushSize} px`;$('brushPreviewDot').style.width=`${Math.min(48,brushSize)}px`;$('brushPreviewDot').style.height=`${Math.min(48,brushSize)}px`}
  function addFrame(){if(project.frames.length>=120)return toast('Maximum 120 frames');postOp({type:'frame-add',afterId:activeFrameId,frame:{id:uid(),strokes:[]}})}
  function duplicateFrame(){
    if(project.frames.length>=120)return toast('Maximum 120 frames');
    const src=activeFrame();if(!src)return;
    const strokes=src.strokes.map(s=>({...s,id:uid(),points:s.points.map(p=>[...p])}));
    postOp({type:'frame-add',afterId:activeFrameId,frame:{id:uid(),strokes}});
  }
  function confirmAction(title,message){
    const d=$('confirmDialog');$('dialogTitle').textContent=title;$('dialogMessage').textContent=message;
    return new Promise(resolve=>{d.addEventListener('close',()=>resolve(d.returnValue==='confirm'),{once:true});d.showModal()});
  }
  async function deleteFrame(){if(project.frames.length<=1)return;const yes=await confirmAction('Delete this frame?','This removes the drawing on the selected frame for everyone.');if(yes)postOp({type:'frame-delete',frameId:activeFrameId})}
  async function clearFrame(){if(!activeFrame()?.strokes.length)return;const yes=await confirmAction('Clear this frame?','Every stroke on this frame will be removed for everyone.');if(yes)postOp({type:'frame-clear',frameId:activeFrameId})}
  function undo(){const frame=activeFrame();if(frame?.strokes.length)postOp({type:'stroke-remove',frameId:frame.id,strokeId:frame.strokes[frame.strokes.length-1].id})}
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
  function paintExportFrame(ctx,frame){paintFrameOn(ctx,frame,960,540)}
  async function exportVideo(){
    if(exportBusy||!project)return;
    if(!('MediaRecorder' in window)||!HTMLCanvasElement.prototype.captureStream){toast('Video export requires a modern browser like Chrome or Edge');return;}
    const supported=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4;codecs=avc1.42E01E','video/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
    if(!supported){toast('Your browser does not support canvas video recording');return;}
    exportBusy=true;stopPlay();
    const button=$('exportBtn'),label=button.querySelector('span');
    button.disabled=true;label.textContent='Exporting…';
    const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
    const ctx=canvas.getContext('2d',{alpha:false});
    const frames=project.frames.map(f=>({id:f.id,strokes:f.strokes.map(s=>({...s,points:s.points.map(p=>[...p])}))}));
    const fps=project.fps;
    let stream,recorder;
    try{
      paintExportFrame(ctx,frames[0]);stream=canvas.captureStream(30);
      recorder=new MediaRecorder(stream,{mimeType:supported,videoBitsPerSecond:3_000_000});
      const parts=[];recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};
      const finished=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||new Error('Recording failed'))});
      recorder.start(100);
      // Short flipbooks loop enough times to make a watchable clip (at least 1.5s).
      const loops=Math.max(1,Math.ceil((1.5*fps)/frames.length));
      const total=Math.max(1,loops*frames.length),delay=1000/fps;
      for(let i=0;i<total;i++){
        paintExportFrame(ctx,frames[i%frames.length]);
        const start=performance.now();
        label.textContent=`Exporting ${Math.round((i+1)/total*100)}%`;
        await sleep(Math.max(0,delay-(performance.now()-start)));
      }
      // Wait for a final encoded video packet before stopping.
      await sleep(100);
      recorder.stop();await finished;
      const blob=new Blob(parts,{type:supported});
      if(!blob.size)throw new Error('The browser produced an empty video');
      const ext=supported.startsWith('video/mp4')?'mp4':'webm';
      const filename=(project.title||'animation').replace(/[^\w\d _-]+/g,'').trim().replace(/\s+/g,'-').slice(0,60)||'animation';
      const url=URL.createObjectURL(blob),anchor=document.createElement('a');
      anchor.href=url;anchor.download=`${filename}.${ext}`;document.body.append(anchor);anchor.click();anchor.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60_000);
      toast(`Video exported as .${ext}!`);
    }catch(err){errorMessage(err)}
    finally{if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());exportBusy=false;button.disabled=false;label.textContent='Export video'}
  }
  function bindUI(){
    $('newProject').addEventListener('click',createProject);
    document.querySelectorAll('.tool-button').forEach(el=>el.addEventListener('click',()=>setTool(el.dataset.tool)));
    document.querySelectorAll('.color-swatch').forEach(el=>el.addEventListener('click',()=>setColor(el.dataset.color)));
    $('colorPicker').addEventListener('input',e=>setColor(e.target.value));
    $('brushSize').addEventListener('input',e=>setBrushSize(e.target.value));
    $('undoBtn').addEventListener('click',undo);$('clearFrameBtn').addEventListener('click',clearFrame);
    $('onionToggle').addEventListener('change',e=>{onion=e.target.checked;renderCanvas()});
    $('fpsSelect').addEventListener('change',e=>postOp({type:'fps-set',fps:Number(e.target.value)}));
    $('projectTitle').addEventListener('change',e=>postOp({type:'title-set',title:e.target.value}));
    $('projectTitle').addEventListener('keydown',e=>{if(e.key==='Enter')e.target.blur()});
    $('inviteBtn').addEventListener('click',copyInvite);$('sideInviteBtn').addEventListener('click',copyInvite);
    $('exportBtn').addEventListener('click',exportVideo);
    $('playBtn').addEventListener('click',togglePlay);
    $('prevFrameBtn').addEventListener('click',()=>goFrame(-1));$('nextFrameBtn').addEventListener('click',()=>goFrame(1));
    $('firstFrameBtn').addEventListener('click',()=>selectFrame(project.frames[0].id));$('lastFrameBtn').addEventListener('click',()=>selectFrame(project.frames.at(-1).id));
    $('addFrameBtn').addEventListener('click',addFrame);$('duplicateFrameBtn').addEventListener('click',duplicateFrame);$('deleteFrameBtn').addEventListener('click',deleteFrame);
    drawCanvas.addEventListener('pointerdown',pointerDown);drawCanvas.addEventListener('pointermove',pointerMove);
    drawCanvas.addEventListener('pointerup',pointerUp);drawCanvas.addEventListener('pointercancel',pointerUp);
    drawCanvas.addEventListener('contextmenu',e=>e.preventDefault());
    document.addEventListener('keydown',e=>{
      if(!project || ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)||$('confirmDialog').open)return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();return;}
      if(e.key===' '){e.preventDefault();togglePlay()}
      else if(e.key==='ArrowLeft'){e.preventDefault();goFrame(-1)}
      else if(e.key==='ArrowRight'){e.preventDefault();goFrame(1)}
      else if(e.key.toLowerCase()==='b')setTool('pen');
      else if(e.key.toLowerCase()==='e')setTool('eraser');
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
