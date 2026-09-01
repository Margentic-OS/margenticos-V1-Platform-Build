// A list of ordinary English words, used to decide whether a CAPITALISED word is a name.
//
// ─── WHY A WORD LIST AND NOT A LIST OF NAMES ─────────────────────────────────
//
// The problem this solves is stated in sentence-initial-names.ts. In short: the first
// word of a sentence is capitalised by convention, so capitalisation cannot tell a name
// from an ordinary word there, and the gate that relies on capitalisation goes blind.
//
// The obvious fix is a list of the names we are afraid of. That was rejected on purpose.
// A denylist of the entities currently in the writer prompt protects against exactly those
// strings and rots the moment an example is edited. It would also do nothing about an
// invented company or a hallucinated regulator, which are the failures that actually
// matter, because those names have never been written down anywhere.
//
// So the list runs the other way round. We enumerate ORDINARY ENGLISH, which is a closed
// and slow-moving set, and treat everything outside it as a possible name. An invented
// company is caught by construction: "Taffet" is not English, and no edit to any prompt
// changes that.
//
// ─── WHY FREQUENCY AND NOT A DICTIONARY ──────────────────────────────────────
//
// A full dictionary is the wrong instrument, measured rather than assumed. macOS ships
// /usr/share/dict/words with 235,976 entries, of which 25,203 are capitalised proper
// nouns. It contains "pani" and "jason". Loading it would hand three of the twelve known
// leaks a free pass and add 2.5MB to the bundle to do it.
//
// This list is COMMON English plus the vocabulary this particular copy is written in.
// Rarity is the signal we are trading on: a word rare enough to be missing from a
// frequency list is rare enough that a capitalised instance of it is more likely a name
// than a sentence opener. That is why "treasury" and "cave" are absent. Both are real
// words, and both appear in the writer prompt as parts of names.
//
// ─── HOW TO CHANGE IT ────────────────────────────────────────────────────────
//
// Adding a word makes the gate MORE permissive and can only cause a missed leak, never a
// blocked email. That is the safe direction, and it is the direction the report-only log
// is designed to inform: a false positive in the log is a word that belongs here.
//
// Removing a word makes the gate stricter and risks rejecting legitimate copy. Do not
// remove one to catch a specific name. Names are caught by absence, not by exclusion.
//
// ONE WORD IN THIS LIST TRIPS THE TOOL-NAME PRE-COMMIT SCAN: "instantly", the adverb, in
// the adverb block. It is ordinary English and has nothing to do with the vendor of the
// same name. It stays, on the rule directly above: removing an ordinary word to catch a
// specific name is the mistake this list exists to avoid. Flagged here so the next person
// running that scan does not have to work it out again.

// Lemmas. Inflected forms are handled by isOrdinaryWord below rather than listed here, so
// "buyers", "running" and "finding" are all covered by "buyer", "run" and "find".
const WORDS = `
a about above across after again against all almost alone along already also although
always am among an and another any anybody anyone anything anyway anywhere are around as
at away back be because been before behind being below beneath beside besides best better
between beyond both but by came can cannot could did do does doing done down during each
either else enough even ever every everybody everyone everything everywhere except far few
for from further had half hardly has have having he hence her here hers herself him
himself his how however i if in indeed inside instead into is it its itself just last
least less lest let like likely little many may maybe me meanwhile might mine more most
much must my myself near nearly neither never next no nobody none nor not nothing now
nowhere of off often on once one only onto or other others otherwise ought our ours
ourselves out outside over own perhaps plenty rather really same seldom several shall she
should since so some somebody somehow someone something sometimes somewhat somewhere soon
still such than that the their theirs them themselves then there therefore these they
this those though through throughout thus till to together too toward towards under
unless until up upon us usually very was we well were what whatever when whenever where
whereas wherever whether which while who whoever whole whom whose why will with within
without would yes yet you your yours yourself

accept add admit advise afford agree aim allow announce answer appear apply approach
approve argue arrange arrive ask assume attend avoid back become begin believe belong
book bring build buy call carry catch cause change charge check choose claim clear close
collect come commit compare complete concern confirm connect consider contact continue
cost cover create cut deal decide deliver depend describe deserve design develop discover
discuss do double doubt drive drop earn ease email enable encourage end engage enjoy
ensure enter examine exist expand expect experience explain explore face fail fall feel
fill find finish fit fix focus follow forget form found gain get give go grow guess
handle happen have head hear help hire hit hold hope identify imagine improve include
increase indicate influence inform intend introduce invest invite involve join keep kick
know land laugh launch lead learn leave let lift like limit listen live look lose love
maintain make manage mark match matter mean measure meet mention miss move name need
notice offer open operate order owe own pass pay perform pick place plan play point post
prefer prepare present press prevent produce promise protect prove provide publish pull
push put raise reach read realise realize receive recognise recognize recommend record
reduce refer reflect refuse regard release remain remember remind remove repeat replace
reply report represent request require reserve resolve respond rest result return review
run save say scale search see seek seem sell send serve set settle share shift ship show
sign sit skip solve sort sound speak spend split stand start state stay step stick stop
struggle study suggest supply support suppose switch take talk teach tell tend test thank
think throw touch track train travel treat try turn understand update use value visit
wait walk want watch wear win wish wonder work worry write

ability access account action activity advantage advice agency agenda agreement amount
answer approach area argument arrangement article aspect attempt attention audience
author authority background balance base basis benefit board body book bottom box brand
break budget building business call capacity capital care career case cash cause centre
century chain chair challenge chance change channel chapter charge chart choice circle
city claim class client comment committee community company comparison competition
concern condition conference confidence connection consideration content context contract
control conversation copy corner cost council country couple course cover credit crisis
culture curve customer cycle damage data date day deal decision degree delay demand
department depth description design detail development difference difficulty direction
director discussion distance division document dollar door doubt drive duty economy edge
education effect effort element email employee end energy engine environment equipment
error estate event evidence example exchange exercise existence expense experience expert
explanation extent eye face fact factor failure family feature feed feedback feel field
figure file film finance firm fit floor flow focus following force form format forum
foundation founder frame friend front function fund future gain game gap gate general
generation goal government grade ground group growth guide habit half hand head health
heart help history hold home hope hour house idea image impact importance improvement
income increase individual industry influence information initiative input insight
instance institution instruction insurance intention interest internet interview issue
item job journey judge judgement key kind knowledge lack land language law layer leader
learning length letter level life light limit line link list literature load loan
location look loss lot love machine magazine mail main majority management manager
manner market marketing match material matter meal meaning measure media medium meeting
member memory message method middle mind minute mistake model moment money month morning
motion move movement name nation nature need network news night none note notice number
object objective obligation occasion offer office officer operation opinion opportunity
option order organisation organization origin outcome output owner page paper part
partner party path pattern pause payment peace people percentage performance period
person phase phone picture piece pipeline place plan plant platform play player point
policy population position possibility post potential power practice presence present
president press pressure price principle print priority problem procedure process produce
product profession professional profile profit program progress project promise proof
property proposal proposition prospect provider public purchase purpose quality quantity
quarter question queue race range rate ratio reach reaction reader reality reason
recognition record reference referral reflection region relation relationship release
report request requirement research reserve resource respect response responsibility rest
result return revenue review right risk role room round route row rule run safety sale
sample scale scene schedule scheme school science scope score screen search season seat
second section sector security selection sense sentence sequence series service session
set setting shape share sheet shift ship shop show side sign signal similarity site
situation size skill sleep society software solution sound source space speaker special
speed spend spirit sport spot spread staff stage stake standard start state statement
station status step stock stop store story strategy street strength stress structure
student study stuff style subject success summary supply support surface survey system
table talk target task tax team technology term test text theme theory thing thought
time title today tone tool top topic total touch trade traffic training transfer travel
treatment trend trial trip trouble trust truth turn type understanding unit university
update usage use user value variety version video view visit voice volume wall war
watch water way wealth week weight while will win window word work worker world worth
writer writing year yesterday

able above absolute active actual additional advanced afraid alive alone amazing angry
annual anxious appropriate available average aware awful bad basic beautiful big black
blue bright brief brilliant broad busy calm capable careful central certain cheap clean
clear clever close cold comfortable commercial common competitive complete complex
concerned confident considerable consistent constant content cool correct critical
crucial current daily dark dead dear deep detailed different difficult digital direct
distant double dry due early easy economic effective efficient either electric elegant
empty entire equal essential even eventual exact excellent exciting existing expensive
external extra extreme fair familiar famous fast favourite final financial fine firm
first fit flat foreign formal former forward free frequent fresh friendly full fun
fundamental funny future general generous gentle genuine global good grateful great green
grey growing guilty happy hard healthy heavy helpful high honest hot huge human ideal
identical immediate important impossible incredible independent individual industrial
inevitable initial inner instant intelligent interesting internal international joint
junior key kind known large late latest leading left legal light likely limited little
live local logical long loose loud low lucky main major manual massive mature maximum
mean medical medium mental middle military minimum minor mixed mobile modern narrow
national natural necessary negative nervous neutral new next nice normal notable obvious
odd official old only open opposite optimistic ordinary organic original other outside
outstanding overall parallel particular past patient perfect permanent personal physical
plain pleasant political poor popular positive possible potential powerful practical
precise preferred pregnant present previous primary prime principal printed prior private
probable productive professional profitable progressive proper proud proven public pure
quick quiet rapid rare raw ready real realistic reasonable recent regular related
relative relevant reliable remarkable remote responsible rich right rough round routine
royal rural sad safe same satisfied scientific second secret secure select senior
sensible sensitive separate serious severe sharp short sick significant silent similar
simple single slight slow small smart smooth social soft solid sorry sound special
specific stable standard steady still straight strange strategic strong stupid subject
substantial successful sudden sufficient suitable superior sure surprised sweet
sympathetic technical temporary tense terrible thick thin third thorough tight tiny
tired top total tough traditional true typical ultimate unable unhappy unique unlikely
unusual upper urgent useful usual valid valuable various vast verbal vertical visible
vital warm weak wealthy weekly welcome wet white whole wide wild willing wise wonderful
wooden worried wrong young

again ahead already anymore anyway apart automatically badly barely carefully certainly
clearly closely completely constantly correctly currently daily definitely deliberately
directly easily effectively either entirely equally especially essentially eventually
exactly explicitly extremely fairly finally firmly forever formally fortunately forward
frequently fully generally gently genuinely gradually greatly hardly heavily honestly
hopefully immediately increasingly initially instantly largely lately later lightly
literally locally loudly mainly mostly mutually naturally nearly necessarily normally
obviously occasionally officially only openly originally particularly partly perfectly
permanently personally physically possibly potentially practically precisely presently
previously primarily probably properly publicly quickly quietly quite rapidly rarely
readily reasonably recently regularly relatively reliably repeatedly respectively roughly
seriously severely shortly significantly similarly simply slightly slowly smoothly
specifically steadily strongly successfully suddenly sufficiently surely surprisingly
technically temporarily thoroughly thus tightly totally truly typically ultimately
unfortunately uniquely unusually urgently usefully virtually visibly widely willingly

afternoon annual april august autumn daily date day december decade evening february
friday hour january july june march may midnight moment monday month monthly morning
night november october quarter quarterly saturday season september spring summer sunday
thursday today tomorrow tonight tuesday today wednesday week weekday weekend weekly
winter year yearly yesterday

billion couple dozen eight eighteen eighty eleven fifteen fifty first five forty four
fourteen fourth half hundred million nine nineteen ninety once one second seven
seventeen seventy several six sixteen sixty ten third thirteen thirty thousand three
twelve twenty twice two zero

acquisition advertising advisory audit automation bandwidth benchmark bid bill billing
bio blog booking bottleneck brief broker calendar campaign capability capacity churn
clause coach coaching cold commission compliance consultancy consultant consulting
conversion copywriting credential deadline delivery demo diary discount distribution
downturn ecommerce enquiry enterprise engagement equity escalation estimate event
executive exhibition expansion expertise exposure fee finance follow forecast franchise
freelance funnel governance headcount headline hiring inbound influencer intake
introduction inventory invoice keyword lead leadership ledger legacy licence license
listing logistics mandate manufacturing margin mentor merger messaging methodology
metric milestone momentum negotiation newsletter niche nurture objection onboarding
outbound outreach outsourcing overhead partnership payroll pension pilot pitch placement
pledge podcast portfolio positioning practice premium presentation pricing procurement
prospecting provider publisher qualification quota quote reach recruitment referral
refresh registration regulation regulator renewal reputation retainer retention revenue
roadmap rollout roster salary sales scaling scope segment seminar sequence signal slot
speaker specialist sponsor sponsorship staffing stakeholder startup strategy
subscription supplier tender territory testimonial threshold ticket tier timeline touch
traction transaction transformation turnover upsell vendor venture vertical visibility
webinar workflow workload workshop
`

// One set, built once at module load. The source above is a string rather than an array
// literal so the list stays readable and reviewable as prose, which is what it is.
const ORDINARY = new Set(
  WORDS.split(/\s+/).map(w => w.trim().toLowerCase()).filter(Boolean),
)

/** How many distinct words the list holds. Asserted in the tests so a botched edit shows. */
export const ORDINARY_WORD_COUNT = ORDINARY.size

// Irregular past tense and past participle forms, mapped to their lemma.
//
// ─── WHY A MAP HERE AND NOT MORE WORDS IN THE LIST ABOVE ─────────────────────
//
// Measured 2026-08-31: replaying the gate over every stored opening surfaced exactly one
// false positive, "Saw", in "Saw your post from last week: networking presentations...".
// "see" is in the vocabulary, "saw" is not, and every rule in lemmaCandidates below is a
// SUFFIX rule. An irregular past tense changes the stem, so no suffix rule can reach it
// and the word reads as an invented name.
//
// This is an INFLECTION, and the list above is explicitly a list of LEMMAS: "Inflected
// forms are handled by isOrdinaryWord below rather than listed here". Putting "saw" in the
// vocabulary would break that invariant and start a second, unbounded list of forms to
// maintain by hand. So the fix goes where the other inflection rules already live.
//
// IT ALSO SELF-LIMITS, WHICH THE OTHER OPTION DOES NOT. These are CANDIDATES. A form only
// resolves if its lemma is already in the vocabulary, so this map can never admit a word
// the list does not already carry. "drew" proposes "draw", "draw" is not in the list, and
// "Drew" stays caught. Adding forms to the vocabulary directly would have no such check.
//
// MEASURED, NOT ASSUMED, over THIS MAP as it stands: 163 forms are listed and 76 of them
// resolve; the other 87 are INERT because their lemma is absent from the vocabulary above.
// Re-counted 2026-09-01 by running the shipped isOrdinaryWord over every key rather than by
// arithmetic; the figure previously read "inert 80" here, which was a transcription slip for
// 87. "Rose", "Drew", "Bore", "Stole" and "Woke" are all in that inert 87, so the obvious
// proper-noun risks this map
// looked like it carried it does not actually carry. Checked with the real isOrdinaryWord
// rather than read off the map, because the map alone does not tell you which half you are
// in. Adding "rise" or "draw" to the vocabulary later would silently activate them, which
// is worth knowing before doing it.
//
// ACCEPTED TRADE-OFF, STATED RATHER THAN DISCOVERED LATER. Of the 76 that do resolve, the
// ones that are also plausible proper nouns are "Fell", "Won" and "Sat". Each now opens a
// sentence unchallenged. That is the direction this file already commits to at the top
// ("Adding a word makes the gate MORE permissive and can only cause a missed leak, never a
// blocked email") and that sentence-initial-names.ts states as AMBIGUITY RESOLVES TO
// ALLOW. A sentence opening "Won" is far more often the verb than a name, and the cost of
// the other reading is a rejected email and a wasted writer attempt.
//
// RULE ZERO. Irregular English verb forms name no industry, no buyer and no market. This
// map is as neutral for a logistics firm as for a consultancy, which is the test the
// market-specific block further up this file fails.
const IRREGULAR_FORMS: Record<string, string[]> = {
  arose: ['arise'], ate: ['eat'], awoke: ['awake'], bade: ['bid'], beat: ['beat'],
  became: ['become'], began: ['begin'], begun: ['begin'], beheld: ['behold'], bent: ['bend'],
  bit: ['bite'], bitten: ['bite'], blew: ['blow'], blown: ['blow'], bore: ['bear'],
  borne: ['bear'], bought: ['buy'], bound: ['bind'], broke: ['break'], broken: ['break'],
  brought: ['bring'], built: ['build'], burnt: ['burn'], caught: ['catch'], chose: ['choose'],
  chosen: ['choose'], clung: ['cling'], crept: ['creep'], dealt: ['deal'], dove: ['dive'],
  drank: ['drink'], drawn: ['draw'], drew: ['draw'], driven: ['drive'], drove: ['drive'],
  dug: ['dig'], eaten: ['eat'], fallen: ['fall'], fed: ['feed'], fell: ['fall'],
  felt: ['feel'], fled: ['flee'], flew: ['fly'], flown: ['fly'], forbade: ['forbid'],
  forgave: ['forgive'], forgot: ['forget'], forgotten: ['forget'], fought: ['fight'],
  found: ['find'], froze: ['freeze'], frozen: ['freeze'], gave: ['give'], given: ['give'],
  gone: ['go'], got: ['get'], gotten: ['get'], grew: ['grow'], grown: ['grow'],
  heard: ['hear'], held: ['hold'], hid: ['hide'], hidden: ['hide'], hung: ['hang'],
  kept: ['keep'], knew: ['know'], known: ['know'], laid: ['lay'], lain: ['lie'],
  leant: ['lean'], learnt: ['learn'], led: ['lead'], left: ['leave'], lent: ['lend'],
  lit: ['light'], lost: ['lose'], made: ['make'], meant: ['mean'], met: ['meet'],
  mistook: ['mistake'], overcame: ['overcome'], oversaw: ['oversee'], paid: ['pay'],
  proven: ['prove'], ran: ['run'], rang: ['ring'], rebuilt: ['rebuild'], rewrote: ['rewrite'],
  ridden: ['ride'], risen: ['rise'], rode: ['ride'], rose: ['rise'], rung: ['ring'],
  said: ['say'], sang: ['sing'], sank: ['sink'], sat: ['sit'], saw: ['see'], seen: ['see'],
  sent: ['send'], sewn: ['sew'], shaken: ['shake'], shone: ['shine'], shook: ['shake'],
  shot: ['shoot'], showed: ['show'], shown: ['show'], shrank: ['shrink'], slept: ['sleep'],
  slid: ['slide'], sold: ['sell'], sought: ['seek'], sown: ['sow'], spent: ['spend'],
  spilt: ['spill'], spoke: ['speak'], spoken: ['speak'], sprang: ['spring'], spun: ['spin'],
  stole: ['steal'], stolen: ['steal'], stood: ['stand'], strove: ['strive'],
  struck: ['strike'], strung: ['string'], stuck: ['stick'], stung: ['sting'], sung: ['sing'],
  sunk: ['sink'], swam: ['swim'], swept: ['sweep'], swore: ['swear'], swum: ['swim'],
  swung: ['swing'], taken: ['take'], taught: ['teach'], thought: ['think'], threw: ['throw'],
  thrown: ['throw'], told: ['tell'], took: ['take'], tore: ['tear'], torn: ['tear'],
  trod: ['tread'], underlay: ['underlie'], understood: ['understand'],
  undertook: ['undertake'], undone: ['undo'], upheld: ['uphold'], went: ['go'],
  withdrawn: ['withdraw'], withdrew: ['withdraw'], withheld: ['withhold'], woke: ['wake'],
  woken: ['wake'], won: ['win'], wore: ['wear'], worn: ['wear'], wound: ['wind'],
  wove: ['weave'], written: ['write'], wrote: ['write'], wrung: ['wring'],
}

/**
 * Candidate lemmas for an inflected form, so the list above can stay lemma-sized.
 *
 * Deliberately generous and deliberately WRONG-TOLERANT. Every extra candidate can only
 * turn a reject into an allow, and allowing is the safe direction here. "Runnings" is not
 * a word, but proposing "running" and "run" for it costs nothing.
 */
function lemmaCandidates(word: string): string[] {
  const out = [word]
  const add = (w: string) => { if (w.length >= 2) out.push(w) }

  // Irregular past tense and past participle, which no suffix rule below can reach.
  // Proposed as candidates like every other rule here, so the lemma still has to be in
  // the vocabulary for the word to be allowed.
  for (const lemma of IRREGULAR_FORMS[word] ?? []) add(lemma)

  // Plurals and third person: shows -> show, buyers -> buyer, companies -> company
  if (word.endsWith('ies')) { add(word.slice(0, -3) + 'y') }
  if (word.endsWith('es')) { add(word.slice(0, -2)); add(word.slice(0, -1)) }
  if (word.endsWith('s') && !word.endsWith('ss')) { add(word.slice(0, -1)) }

  // Agent nouns: founders -> founder -> found, buyers -> buyer -> buy
  if (word.endsWith('ers')) { add(word.slice(0, -3)); add(word.slice(0, -1)) }
  if (word.endsWith('er')) { add(word.slice(0, -2)); add(word.slice(0, -1)) }
  if (word.endsWith('ors')) { add(word.slice(0, -3)); add(word.slice(0, -1)) }
  if (word.endsWith('or')) { add(word.slice(0, -2)) }

  // Gerunds: finding -> find, running -> run (doubled), making -> make (dropped e)
  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3)
    add(stem)
    add(stem + 'e')
    if (/(\w)\1$/.test(stem)) add(stem.slice(0, -1))
  }

  // Past tense: worked -> work, tried -> try, scaled -> scale, dropped -> drop
  if (word.endsWith('ied')) { add(word.slice(0, -3) + 'y') }
  if (word.endsWith('ed')) {
    const stem = word.slice(0, -2)
    add(stem)
    add(stem + 'e')
    if (/(\w)\1$/.test(stem)) add(stem.slice(0, -1))
  }

  // Adverbs: quickly -> quick, easily -> easy
  if (word.endsWith('ily')) { add(word.slice(0, -3) + 'y') }
  if (word.endsWith('ly')) { add(word.slice(0, -2)) }

  return out
}

/**
 * True when the word is ordinary English rather than a name.
 *
 * Case-insensitive: the caller passes a capitalised word and the question is precisely
 * whether that capital means anything.
 */
export function isOrdinaryWord(word: string): boolean {
  const clean = word.toLowerCase().replace(/[^a-z'-]/g, '').replace(/'s$/, '')
  if (!clean) return false
  if (ORDINARY.has(clean)) return true

  // A hyphenated compound is ordinary when both halves are: "follow-up", "long-term".
  if (clean.includes('-')) {
    const parts = clean.split('-').filter(Boolean)
    if (parts.length > 1 && parts.every(p => ORDINARY.has(p) || lemmaCandidates(p).some(c => ORDINARY.has(c)))) {
      return true
    }
  }

  return lemmaCandidates(clean).some(c => ORDINARY.has(c))
}
