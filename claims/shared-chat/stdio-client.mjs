import { openProcess } from './duplex.mjs'
const proc=await openProcess({kind:'stdio',subject:process.env.CLAIMS_TOOL_SUBJECT,argv:JSON.parse(process.env.CLAIMS_TOOL_ARGV)})
proc.output.pipe(process.stdout)
proc.stderr.pipe(process.stderr)
process.once('SIGTERM',()=>{void proc.terminate()})
process.stdin.on('data',chunk=>{void proc.write(chunk).catch(()=>proc.terminate())})
process.stdin.once('end',()=>proc.end())
process.exitCode=(await proc.done).exitCode ?? 1
