// One detector set, applied identically to BEFORE and AFTER. Any change here changes both.
import fs from 'node:fs'
import { readabilityScore } from '@/lib/style/readability'
import { findFirmographicFigures } from '@/lib/style/firmographic'
import { frameShingles } from '@/lib/style/sentence-frames'


export type Row = { id:string; name:string; obs:string; brg:string; q:string; full:string }

export function rowsFrom(snapPath:string): { rows:Row[]; researched:number; withCopy:number } {
  const d = JSON.parse(fs.readFileSync(snapPath,'utf8'))
  const ps = d.prospects ?? d
  const hook = ps.filter((p:any)=>p.signal_relevance==='use_as_hook' && p.personalisation_trigger)
  const rows = hook.map((p:any)=>{
    const seg = p.personalisation_trigger.split(/\n\s*\n/).map((s:string)=>s.trim()).filter(Boolean)
    return { id:p.id, name:p.first_name, obs:seg[0]??'', brg:seg.slice(1).join(' '), q:p.personalisation_question??'', full:p.personalisation_trigger }
  })
  return { rows, researched: ps.length, withCopy: hook.length }
}

const CV_CONCUR=/\b(on top of|alongside|concurrently|at the same time|in parallel|side by side|back to back|simultaneously|both (?:it and|listed|active|employed|organisations|companies|roles)|all three (?:roles|active)|still active|running both|second (?:founder|role))\b/i
const CV_ROLE=/\b(CEO|COO|CFO|CTO|CPO|CRO|President|Founder|Co-?[Ff]ounder|Director|Partner|Chair(?:ed)?|Chief|Advisor|board seat|VP|instructor|faculty|Executive Director|Team Leader|Senior Facilitator|Client Partner)\b/
const CV_TEN=/\b(since (?:late |mid-|early )?(?:19|20)\d{2}|for (?:over |nearly |at least )?\w+ (?:years?|months?)|\b\d+ years\b|(?:January|February|March|April|May|June|July|August|September|October|November|December) (?:19|20)\d{2}|in (?:19|20)\d{2}\b)/
const CAUSAL=/\b(,\s*so\b|\bso\b(?=\s+(?:the|it|they|you|there|new|every|any))|because|which means|meaning|\buntil\b|\bwhile\b|\bleaving\b|\bwhich puts\b|\bwhich leaves\b)/i
const VERDICT:[RegExp,string][]=[
  [/\bwhich (?:tells me|says|means|puts)\b/i,'verdict marker'],
  [/\bwaits? for the next referral|\breferrals? (?:land|arrive)|through the same door|passes your name along|tend to run through the founder|usually (?:someone )?already inside|waits until you go looking/i,'verdict on how they win work'],
  [/\bnothing (?:published|original)\b|\bno original signal\b|\bwill not find\b|\bnever (?:heard|see|find) it\b|\bnothing .* has turned up\b/i,'names an absence'],
  [/\bis the ceiling on\b|\bcosts the same as a lost client\b|\brather than anything underneath them\b/i,'verdict on their business'],
]
const DEFER_SUBJ=/\b(sales conversation|client conversation|client conversations|new[- ]client (?:conversation|outreach|pipeline)|new[- ]business (?:outreach|conversations?)|outbound|outreach|prospecting|pipeline|next (?:client|prospective client|qualified client|engagement))\b/i
const DEFER_V=/\b(waits?|wait|sits?|sit|gets pushed|pushed back|slips?|last thing|gives up its slot|rarely gets its own slot|fewer hours|gets a slot|wait out|queue behind|behind)\b/i

const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
const grams=(s:string,n:number)=>{const w=norm(s).split(' ');return new Set(Array.from({length:Math.max(0,w.length-n+1)},(_,i)=>w.slice(i,i+n).join(' ')))}

// THE PROMPT IS AN ARGUMENT, NOT AN IMPORT. F5 asks whether the writer copied an example
// from THE PROMPT IT WAS GIVEN, so before-copy must be scored against the before-prompt.
// Scoring old output against the new prompt silently counts a leak as fixed the moment the
// example is deleted, which flatters the fix by exactly the thing being measured.
export function measure(rows:Row[], promptSource:string) {
  const promptQuoted=[...promptSource.matchAll(/"([^"]{25,300})"/g)].map(m=>m[1].replace(/\s+/g,' ').trim())
  const pg=new Set<string>(); for(const q of promptQuoted) for(const g of grams(q,5)) pg.add(g)
  const frames=new Map<string,string[]>()
  for(const r of rows) for(const f of frameShingles(r.brg)) frames.set(f,[...(frames.get(f)??[]),r.id])
  const collided=new Set([...frames.values()].filter(v=>new Set(v).size>1).flat())
  const F:Record<string,Row[]>={}
  const put=(k:string,r:Row)=>{(F[k]??=[]).push(r)}
  for(const r of rows){
    const rs=[readabilityScore(r.obs),readabilityScore(r.brg)]
    if(rs.some(s=>s.longSentences.length>0)) put('F1 sentence >25 words',r)
    if(rs.some(s=>s.hedges.length>0))        put('F1b hedge (logged, not gated)',r)
    if(findFirmographicFigures(r.full).length>0) put('F2 provider figure',r)
    if(CV_CONCUR.test(r.obs)||(CV_ROLE.test(r.obs)&&CV_TEN.test(r.obs))) put('F3 CV recitation',r)
    if(collided.has(r.id)) put('F4 shared bridge frame',r)
    if([...grams(r.full,5)].some(g=>pg.has(g))) put('F5 prompt-example leak',r)
    if(CAUSAL.test(r.obs)||CAUSAL.test(r.brg)) put('F6 causal construction',r)
    if(VERDICT.some(([re])=>re.test(r.obs)||re.test(r.brg))) put('F7 verdict / names a lack',r)
    if(DEFER_SUBJ.test(r.brg)&&DEFER_V.test(r.brg)) put('F4b deferral move (any wording)',r)
  }
  return F
}
