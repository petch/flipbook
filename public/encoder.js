/* Browser-only GIF, PNG-sequence and sprite-sheet exporters. No CDN or server dependencies. */
(() => {
  'use strict';
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const canvasBlob = (canvas,type='image/png') => new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Image encoding failed')),type));
  const put16 = (a,i,n) => {a[i]=n&255;a[i+1]=(n>>>8)&255;};
  const put32 = (a,i,n) => {put16(a,i,n);put16(a,i+2,n>>>16);};
  const ascii = str => Uint8Array.from(str,c=>c.charCodeAt(0));
  const palette = new Uint8Array(768);
  for(let i=0;i<256;i++){
    palette[i*3]=Math.round(((i>>5)&7)*255/7);
    palette[i*3+1]=Math.round(((i>>2)&7)*255/7);
    palette[i*3+2]=Math.round((i&3)*255/3);
  }
  function lzw(indices){
    const resetCode=256,endCode=257;
    const bytes=[];let bitBuffer=0,bitsInBuffer=0,codeBits=9,nextCode=258;
    let dictionary=new Map();
    const emit=(code)=>{bitBuffer|=code<<bitsInBuffer;bitsInBuffer+=codeBits;while(bitsInBuffer>=8){bytes.push(bitBuffer&255);bitBuffer>>>=8;bitsInBuffer-=8;}};
    emit(resetCode);
    let prefix=indices[0];
    for(let i=1;i<indices.length;i++){
      const value=indices[i],key=prefix*256+value;
      const found=dictionary.get(key);
      if(found!==undefined){prefix=found;continue;}
      emit(prefix);
      if(nextCode<4096){
        dictionary.set(key,nextCode++);
        // Code-size growth is synchronized to the decoder's next dictionary insertion.
        if(nextCode === (1<<codeBits)+1 && codeBits<12)codeBits++;
      }else{
        emit(resetCode);dictionary=new Map();codeBits=9;nextCode=258;
      }
      prefix=value;
    }
    emit(prefix);emit(endCode);
    if(bitsInBuffer)bytes.push(bitBuffer&255);
    const chunks=[];
    for(let i=0;i<bytes.length;i+=255){const n=Math.min(255,bytes.length-i);chunks.push(n,...bytes.slice(i,i+n));}
    chunks.push(0);
    return Uint8Array.from(chunks);
  }
  async function gif(frames,fps,paint,progress){
    const w=480,h=270,canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const delay=Math.max(2,Math.round(100/fps));
    const header=new Uint8Array(13);header.set(ascii('GIF89a'));
    put16(header,6,w);put16(header,8,h);header[10]=0xf7;
    const pieces=[header,palette,Uint8Array.from([33,255,11,...ascii('NETSCAPE2.0'),3,1,0,0,0])];
    for(let f=0;f<frames.length;f++){
      paint(ctx,frames[f],w,h);
      const data=ctx.getImageData(0,0,w,h).data,indices=new Uint8Array(w*h);
      for(let i=0,j=0;i<data.length;i+=4,j++)indices[j]=(data[i]&224)|((data[i+1]>>3)&28)|(data[i+2]>>6);
      const control=new Uint8Array([33,249,4,4,0,0,0,0]);put16(control,4,delay);
      const descriptor=new Uint8Array(10);descriptor[0]=44;put16(descriptor,5,w);put16(descriptor,7,h);
      pieces.push(control,descriptor,Uint8Array.from([8]),lzw(indices));
      progress(Math.round((f+1)*100/frames.length));await pause();
    }
    pieces.push(Uint8Array.from([59]));
    return new Blob(pieces,{type:'image/gif'});
  }
  const crcTable=new Uint32Array(256);
  for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[i]=c>>>0;}
  function crc32(bytes){let c=-1;for(let i=0;i<bytes.length;i++)c=crcTable[(c^bytes[i])&255]^(c>>>8);return (c^-1)>>>0;}
  function zip(entries){
    const parts=[],central=[];let offset=0;
    for(const {name,bytes} of entries){
      const title=ascii(name),crc=crc32(bytes),n=bytes.length;
      const local=new Uint8Array(30+title.length);put32(local,0,0x04034b50);put16(local,4,20);put16(local,8,0);put32(local,14,crc);put32(local,18,n);put32(local,22,n);put16(local,26,title.length);local.set(title,30);
      parts.push(local,bytes);
      const record=new Uint8Array(46+title.length);put32(record,0,0x02014b50);put16(record,4,20);put16(record,6,20);put32(record,16,crc);put32(record,20,n);put32(record,24,n);put16(record,28,title.length);put32(record,42,offset);record.set(title,46);
      central.push(record);offset+=local.length+n;
    }
    const size=central.reduce((sum,item)=>sum+item.length,0),end=new Uint8Array(22);
    put32(end,0,0x06054b50);put16(end,8,entries.length);put16(end,10,entries.length);put32(end,12,size);put32(end,16,offset);
    return new Blob([...parts,...central,end],{type:'application/zip'});
  }
  async function zipPng(frames,paint,progress){
    const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
    const ctx=canvas.getContext('2d');const entries=[];
    for(let i=0;i<frames.length;i++){
      paint(ctx,frames[i],960,540);
      const bytes=new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());
      entries.push({name:`frame_${String(i+1).padStart(4,'0')}.png`,bytes});
      progress(Math.round((i+1)*100/frames.length));await pause();
    }
    return zip(entries);
  }
  async function sheet(frames,paint,progress){
    const w=480,h=270,columns=Math.min(8,Math.ceil(Math.sqrt(frames.length))),rows=Math.ceil(frames.length/columns);
    const canvas=document.createElement('canvas');canvas.width=w*columns;canvas.height=h*rows;
    const ctx=canvas.getContext('2d');
    const thumb=document.createElement('canvas');thumb.width=w;thumb.height=h;const t=thumb.getContext('2d');
    for(let i=0;i<frames.length;i++){
      paint(t,frames[i],w,h);ctx.drawImage(thumb,(i%columns)*w,Math.floor(i/columns)*h);
      progress(Math.round((i+1)*100/frames.length));await pause();
    }
    return canvasBlob(canvas);
  }
  window.FlipbookExport={gif,zipPng,sheet};
})();
