import fs from 'node:fs'
import { rowsFrom, measure } from './faults-lib'
const ORDER=['F1 sentence >25 words','F1b hedge (logged, not gated)','F2 provider figure','F3 CV recitation','F4 shared bridge frame','F4b deferral move (any wording)','F5 prompt-example leak','F6 causal construction','F7 verdict / names a lack']
const snap=process.argv[2], promptFile=process.argv[3]
const a=rowsFrom(snap); const A=measure(a.rows, fs.readFileSync(promptFile,'utf8'))
console.log(`researched=${a.researched} withCopy=${a.withCopy}`)
for(const k of ORDER) console.log(`  ${k.padEnd(34)} ${String((A[k]??[]).length).padStart(3)}`)
if(process.argv[4]==='--names') for(const k of ORDER) console.log(`\n${k}: ${(A[k]??[]).map(r=>r.name).join(', ')}`)
