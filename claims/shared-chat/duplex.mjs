import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

const maxFrame=512*1024
const encode = (socket,value) => socket.write(JSON.stringify(value)+'\n')
function upgraded(socketPath,path,headers,body) {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path,method:'POST',headers:{Connection:'Upgrade',Upgrade:'tcp',...headers,
      ...(body && {'Content-Type':'application/json','Content-Length':body.length})}})
    req.once('upgrade',(_res,socket,head)=>{ if (head.length) socket.unshift(head); resolve(socket) })
    req.once('response',res=>{res.resume();reject(Error('Stream refused: '+res.statusCode))})
    req.once('error',reject)
    req.setTimeout(15000,()=>req.destroy(Error('Stream handshake timed out')))
    req.end(body)
  })
}

/** The private Unix manager socket is mounted only in Workbench. No engine option crosses this interface. */
export function attachManagerStreams(server, {engineSocket,engine,manager}) {
  server.on('upgrade',async(req,socket,head)=>{
    if (req.url!=='/process' || req.method!=='POST') {socket.destroy();return}
    let lease,stream,id,done=false,chain=Promise.resolve()
    const token=randomUUID(), pidfile='/tmp/.chat-'+token
    const kill=async()=>{
      if (!id || !lease) return
      const record=await engine('GET','/exec/'+id+'/json')
      if (!record.Running) return
      const cleanup=await engine('POST','/containers/'+lease.id+'/exec',{User:'1000:1000',
        Cmd:['sh','-c','if read -r pid < "$1"; then kill -HUP "$pid"; fi','cleanup',pidfile]})
      await engine('POST','/exec/'+cleanup.Id+'/start',{Detach:false,Tty:false},{bytes:true})
    }
    const finish=async()=>{
      if (done) return
      done=true
      try { await kill() } finally { stream?.destroy(); lease?.release(); socket.destroy() }
    }
    socket.on('error',()=>{});socket.once('close',()=>{void chain.then(finish,finish).catch(()=>{})})
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    if (head.length) socket.unshift(head)
    let tty=false,started=false
    const lines=createInterface({input:socket,crlfDelay:Infinity})
    const handle=async line=>{
      if(done) return
      if(line.length>maxFrame) throw Error('Frame too large')
      const message=JSON.parse(line)
      if(!started) {
        const {subject,kind,argv,cols,rows}=message
        if(!['terminal','stdio'].includes(kind) || !Array.isArray(argv) || !argv.length || argv.length>64 ||
            argv.some(arg=>typeof arg!=='string'||arg.includes('\0')||arg.length>8192)) throw Error('Invalid process specification')
        tty=kind==='terminal'
        if(tty && (argv.length!==2 || argv[0]!=='/bin/sh' || argv[1]!=='-i')) throw Error('Unknown terminal')
        started=true
        lease=await manager.acquire(subject)
        if(socket.destroyed) return
        const start=await engine('POST','/containers/'+lease.id+'/exec',{AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:tty,User:'1000:1000',
          WorkingDir:'/workspace',Env:['HOME=/workspace','TERM=xterm-256color'],
          Cmd:['/bin/sh','-c','echo $$ > "$1"; shift; exec "$@"','private-workspace',pidfile,...argv]})
        id=start.Id
        stream=await upgraded(engineSocket,'/exec/'+id+'/start',{},Buffer.from(JSON.stringify({Detach:false,Tty:tty})))
        let buffer=Buffer.alloc(0)
        const send=(fd,bytes)=>{if(!socket.destroyed && !encode(socket,{fd,data:bytes.toString('base64')})) {stream.pause();socket.once('drain',()=>stream.resume())}}
        stream.on('data',chunk=>{
          if (tty) {send(1,chunk);return}
          buffer=Buffer.concat([buffer,chunk])
          while(buffer.length>=8) {
            const n=buffer.readUInt32BE(4)
            if(n>4*1024*1024 || ![1,2].includes(buffer[0])) {stream.destroy(Error('Invalid output'));return}
            if(buffer.length<8+n) break
            send(buffer[0],buffer.subarray(8,8+n));buffer=buffer.subarray(8+n)
          }
        })
        stream.on('error',()=>socket.destroy())
        stream.once('close',async()=>{
          try {
            const status=await engine('GET','/exec/'+id+'/json')
            if(!socket.destroyed) socket.end(JSON.stringify({exit:status.Running ? null : status.ExitCode})+'\n')
          } catch {socket.destroy()}
        })
        if(tty && Number.isInteger(cols) && Number.isInteger(rows)) await resize(cols,rows)
        if(!socket.destroyed) encode(socket,{ready:true})
      } else if(message.resize) await resize(...message.resize)
      else if(message.end) stream.end()
      else if(typeof message.data==='string') {
        const bytes=Buffer.from(message.data,'base64')
        await new Promise((ok,fail)=>stream.write(bytes,err=>err ? fail(err):ok()))
      } else if(message.close) await finish()
      else throw Error('Unknown process operation')
    }
    async function resize(cols,rows) {
      if(!tty || ![cols,rows].every(n=>Number.isInteger(n)&&n>=1&&n<=1000)) throw Error('Invalid terminal size')
      await engine('POST','/exec/'+id+'/resize?h='+rows+'&w='+cols)
    }
    lines.on('line',line=>{chain=chain.then(()=>handle(line)).catch(()=>{socket.destroy()})})
  })
}

export async function openProcess(spec, path=process.env.CLAIMS_WORKSPACE_MANAGER_SOCKET || '/run/chat-manager/workspace.sock') {
  const socket=await upgraded(path,'/process',{})
  const ready=Promise.withResolvers(), done=Promise.withResolvers(), output=new PassThrough(), stderr=new PassThrough()
  void done.promise.catch(()=>{})
  let result,exited=false
  const lines=createInterface({input:socket,crlfDelay:Infinity})
  lines.on('line',line=>{
    try {
      const msg=JSON.parse(line)
      if(msg.ready) ready.resolve()
      else if(Object.hasOwn(msg,'exit')) {exited=true;result=msg.exit}
      else (msg.fd===2 ? stderr : output).write(Buffer.from(msg.data,'base64'))
    } catch {socket.destroy()}
  })
  socket.on('error',()=>{})
  socket.once('close',()=>{
    const err=Error('Private workspace process interrupted')
    ready.reject(err);output.end();stderr.end()
    if(exited) done.resolve({exitCode:result,signal:null})
    else done.reject(err)
  })
  encode(socket,spec)
  try { await ready.promise } catch(error) {socket.destroy();throw error}
  return {pid:0,output,stderr,done:done.promise,
    async write(data) { if(socket.destroyed) throw Error('Terminal closed');encode(socket,{data:Buffer.from(data).toString('base64')}) },
    async resize(cols,rows) { encode(socket,{resize:[cols,rows]}) },
    end() { encode(socket,{end:true}) },
    async terminate() { if(!socket.destroyed) {encode(socket,{close:true});socket.end()} await done.promise.catch(()=>{}) },
    async inspectActivity() { return {state:'unknown',revision:0} },async inspectForeground() { return undefined },
    async signalForeground() { throw Error('Use terminal control characters to signal the foreground process') },
  }
}
