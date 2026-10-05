# The firm-fact tier, the outbound brief and brief-generated templates

Plain-English reference. Built 30 September 2026 on branch `firm-fact-tier`, and extended
from the operator's notes on five reading files (1 and 2 October). The decisions behind it are on
the Notion page "Firm-fact tier: plan (decided 30 September)" and in ADR-062 to ADR-065.

## What this is

Every prospect's Email 1 now comes from one of three tiers, tried in this order:

1. **Tier 1, personalised.** Research found something about the prospect and the writer
   produced an opening that passed every gate. Unchanged from before.
2. **Tier 2, firm fact.** No personalised opening, but the prospect's own website says
   plainly what the firm does. Email 1 opens with one sentence built from that, then the
   client's approved pain line, offer and question. Tier 2 is itself a ladder of two rungs:
   - **The specific fact.** A clause in the firm's own words about what it does ("you help
     growers plan their harvest").
   - **The broad line.** When no specific clause survives the checks, a plain statement of
     what kind of firm it is ("you run an HR consultancy"), held to the same faithfulness
     checks. Added 1 October so that fewer prospects fall all the way to the template.
   - **The line built from the record** (added 2 October). When the website gives neither,
     code builds "Can see you run an HR consultancy." from the data provider's industry and
     the client brief's own words for that kind of firm. No model and no judge. Then a
     slogan from the website, if that is all the page offered.
3. **Tier 3, template.** Everything else: no usable site, a site that is not the firm's, or
   nothing on it that survives the checks. The client's approved template, with no slot in
   it. Every tier 3 prospect carries a reason code saying why (`scripts/tier-census.ts`
   lists them for a whole client).

Three things had to exist for that to work, and all three were built together:

- **The outbound brief.** A short, confirmed statement of what a client's outbound may say:
  ranked pain angles, proof points, what the service does and never claims, buyers the
  wording must not exclude, peer group labels. It lives inside the client's **messaging
  document** as `outbound_brief`.
- **Brief-generated templates.** A new agent writes one template variant per lead pain
  angle (three for a client with three), from the brief and nothing else. The old templates
  are never shown to it.
- **Firm-fact extraction.** One cheap model call reads website text research has already
  stored, and a second, separate call checks the result is faithful to the page.

## What it connects to

| Piece | File | What it does |
|---|---|---|
| Brief shape and checks | `src/lib/outbound-brief/brief.ts` | Types, structural validation, the one reader that pulls the brief out of a messaging document |
| Template lines and rendering | `src/lib/outbound-templates/template-shape.ts` | Slots (`{does}`, `{for_whom}`, `{peer_group}`), slot-free forms, and the renderers every consumer shares |
| Template validator | `src/lib/outbound-templates/validate-templates.ts` | The hard gate on generated templates. No model |
| Template generator | `src/agents/outbound-template-agent.ts` | Writes one variant per lead angle from the brief; peer label judge; scope judge; repair loop |
| Extraction checks | `src/lib/agents/research/firm-fact-checks.ts` | Identity, clause rules, cost maths, the checks version. No model |
| Extraction | `src/lib/agents/research/firm-fact.ts` | The two model calls, the cost gates, storage, the research hook |
| Composition decision | `src/lib/composition/firm-fact-email1.ts` | Decides tier 2 or tier 3 for one prospect and builds the email. No model |
| Sequence coherence | `src/lib/composition/sequence-coherence.ts` | Stops a template follow-up repeating the angle Email 1 used. No model |
| Composition | `src/lib/composition/compose-sequence.ts` | Calls the two modules above; records the tier |
| Recheck controls | `src/lib/agents/research/firm-fact-recheck.ts` | Decides whether a must-fail control was really rejected, and for its own word. No model |
| Reassignment record | `src/lib/agents/research/variant-reassignment.ts` | Records which variant a prospect left when research moves it off one the document dropped. No model |
| Ambiguous wording | `src/lib/style/ambiguous-referent.ts` | Finds phrases that can be read two ways ("someone else"). No model |
| Competitor screen | `src/lib/sourcing/competitor-screen.ts`, `competitor-verdict.ts` | Excludes a prospect that sells what the client sells, before research. Phrases in code, then one small model call. See ADR-063 |
| Thread rule | `src/lib/composition/thread-carried.ts` | A personalised Email 1 is held at upload unless Email 2 or 3 is personalised too. No model. See ADR-064 |
| Approved reason | `src/lib/agents/research/approved-reason.ts`, `reason-match.ts` | The personalised opening argues from the client's approved trigger reason, and the finished line is read back against it. See ADR-065 |

Database (migrations `20260930200000` and `20260930210000`, both applied to production and
the test database):

- `prospects.firm_fact`: the extraction verdict for one prospect. Kept even when it failed,
  so the same prospect is not paid for twice.
- `research_usage.firm_fact`: what the two extraction calls cost. Rows carry `arm = 'firm_fact'`.
- `sent_sequences.opening_tier` and `opening_detail`: which tier each lead received and why.
  With `variant_id` and `messaging_doc_id` (the template version) already on that row, replies
  can be compared by tier, variant and version.
- `system_flags.firm_fact_extraction`: the global stop switch for extraction. On.
- `prospects.competitor_check` (migration `20261001210000`, applied to both databases): the
  competitor screen's verdict for one prospect. Empty means never judged.

## How to operate it

All from the command line, operator only. None of these approves anything.

1. **Land a client's brief** (the file is client data: keep it under `.writer-export/`, never commit it):
   `npx tsx scripts/run-outbound-template-agent.ts --org <id> --brief <brief.json>`
   This creates a pending messaging suggestion: the live document plus the brief.
2. **Generate the templates** into that same suggestion:
   `npx tsx scripts/run-outbound-template-agent.ts --org <id> --generate`
   Before anything is written, one small model call asks whether the brief's default peer
   label wrongly describes a buyer the brief says is in scope. If it does, the run stops
   there and names the label: that is a fault in the brief, and no rewrite can fix it.
   Every lead angle must end with a passing variant, or the run fails and the suggestion is
   left as it was. A passing result is saved to a file before the suggestion is written, so
   a database error cannot lose it. A failed run always saves its attempt to a file and prints the command
   to keep what passed: `--generate --keep A,B --keep-from <that file>`. `--keep A,C` on its
   own keeps variants from the pending suggestion. Kept variants are still re-checked and
   re-judged, and repaired if either now fails.
   There can only be one pending messaging suggestion per client, which is why the brief and
   the templates travel together and are approved as one document.
3. **Approve the suggestion** in the dashboard, as for any document.
4. **Switch the tier on or off per client** in the pending suggestion:
   `npx tsx scripts/run-outbound-template-agent.ts --org <id> --tier on` (or `off`). ON is
   refused unless the brief is valid, the opener frames exist and every variant has lines
   written from the current brief. The switch is carried through later regenerations.
   `--max-usd <n>` caps a generation run (default $3; a run can end one call over).
   `--written-by "<text>"` records who wrote lines finished by hand.
5. **Backfill facts** for prospects already researched and not yet uploaded:
   `npx tsx scripts/run-firm-fact.ts --org <id>`
   New research runs it automatically once the tier is on.
6. **Reading files** before an upload:
   `npx tsx scripts/sequence-reading-report.ts --org <id> --facts <files> --out .writer-export/<file>.md`
   Whole sequences from real prospects, built by composition in dry run. Writes nothing.
   Add `--followups` to have each personalised sequence's Emails 2 and 3 written in dry run,
   as the backfill below would write them (paid, stores nothing).
7. **The whole cohort, not a dozen:** `npx tsx scripts/tier-census.ts --org <id>`
   Free. Says how many prospects land in each tier and rung, a reason code for every tier 3
   prospect, and for every personalised prospect whether the upload would hold it.
   **Run it BEFORE step 3.** It composes against the PENDING suggestion with the tier
   treated as on, so its counts are what the upload would do once that suggestion is
   approved. With no pending suggestion it stops and says so.
8. **Write the personalised follow-ups** a held prospect is waiting for:
   `npx tsx --env-file=.env.local scripts/backfill-followups.ts --org=<id> --commit`
   Dry run without `--commit`. It reaches every not-yet-uploaded prospect with a personalised
   Email 1 whose follow-ups do not carry it, including ones made stale by a new messaging
   document. Run it after approving a new messaging document and before uploading.
   `--limit=N` bounds how many prospects the writer is run for, so the same command run
   again reaches the next ones. `--after=<id>` starts after a prospect id, to step past
   ones whose follow-ups are refused on every run.
   **It cannot help every held prospect, and it names the ones it cannot.** At the end it
   prints `STILL HELD AT UPLOAD` with each prospect id, why, and what that one needs:
   - *Email 1 was not written to a current approved trigger reason* (every opening written
     before that rule, or to a reason since reworded). The backfill makes no model call for
     these. Run their research again from the command line
     (`scripts/run-research.ts --ids <ids> --allow-overwrite-trigger`), which writes a new
     Email 1 and its follow-ups together.
   - *No research inside the 30-day window.* Run their research again.
   - *The variant's template Emails 2 and 3 leave nothing to model on.* Fix the messaging
     document.
   - *Both follow-ups were refused by their own checks.* May pass on another run; each run
     pays again.
   A prospect is listed only when the upload would really hold it.
9. **See who the competitor screen would exclude,** before anybody is:
   `npx tsx scripts/run-competitor-screen.ts --org <id>` (dry run; `--commit` writes).

## The rules a tier 2 email must meet

At extraction, in code: the page is the prospect's own (identity check), is not a bot-check
page, and is under 90 days old. The clause starts "you" plus a present-tense verb, is 12 words
or fewer and one clause, and carries no number, praise, marketing word, time word, hedge or
name that is not on the page. It holds no "your" (the page's "your" is its customer), no
comma and no dash, and it must name something specific: a clause true of any firm is refused. The quote is word for word on the page.

**Every content word of the clause must be in its own quote** (operator rule 10, 1 October).
The only exception in the code check is "help" or "provide" straight after "you", and that
one word is the judge's to decide: code cannot tell whether "you provide parcels" is fair
for a firm whose page says it builds software that tracks parcels, because every noun is
in the quote. This is wider than "every
noun": there is no part-of-speech tagger here, and a nouns-only rule could not catch an
added verb. It is strict on purpose. Measured on 32 real clauses written before the rule,
5 pass; 9 of the rejected are honest paraphrases ("clients" for "businesses"). Extraction
is now told to reuse the quote's own words, that it may leave a word out and never put one
in, and that a noun stays a noun.

Two forms of a word match only by **inflection**: a plural, a tense, an -ing form ("make"
and "making", "city" and "cities"). The first version also matched any two endings on a
shared stem, so it called "leadership" and "leaders" one word, and "general" and
"generation". That let an added idea through a check whose point is that it cannot be
argued with. The price is that "install" no longer matches "installation"; the extraction
prompt says so.

Then a separate model call (the faithfulness judge) sees only the quote and the clause. It
goes through the clause one word at a time and says whether the quote states each word, and
then whether the clause TWISTS the quote (`twists_the_quote`): changes what it means, or
says of the company what the quote says of something else. A clause that only leaves part
of the quote out does not twist it. Code passes the clause only if every word is stated,
the audit covers every word of the clause, the clause does not twist its quote, and no
number or praise was added.

That question was worded three ways on 2 October and two were withdrawn after a real run
each. "Does the clause say the same as the quote" refused a clause that named one item of
a list the quote gives. "Is the clause a true statement about the company" made the judge
pass a real must-fail control on two reads of three. Do not reword it without replaying
the controls (`--recheck`, below). An unanswered question is a fail, not a "no". The list of
small words to skip is one constant shared by the code check and the judge's prompt, and
code drops an audit entry for any of them, because the judge was measured auditing them
anyway.

**A clause is repaired by removal before it is refused** (2 October, operator note 6 on the
fourth reading). Every candidate is tried as the model wrote it first. Only then:

- **The first item of a list.** "you provide digital marketing, website design, and brand
  development" is refused for its commas; "you provide digital marketing" is what the page
  says and nothing more. Only where the cut leaves a phrase that stands: the first item ends
  on a word with a noun's form, no later item is a describing phrase, and the head does not
  need both sides ("the gap between ...").
- **Cut at the word cap.** A clause over 12 words is cut before a trailing phrase, and only
  where what is kept ends on a noun's form. A clause holding a word that fences its claim in
  ("stop", "against", "only", "without") is never cut: with its ending gone it could say the
  opposite of the page.
- **"&" is written "and"** where it joins two words. "M&A" is left alone and the clause is
  refused for it.
- **Running case.** A word the page writes in lower case is lowered; a clause from a heading
  is lowered throughout; a run of Title Case is lowered whole or not at all; a word the page
  uses as a name in running text keeps its capital.

A repair only removes words, so a repaired clause holds no word the page does not. It can
still be BROADER than the page (a limit left off). A repair that leaves fewer than two
specific words is not offered. The repaired clause is then held to every check and the
judge like any other. What a repair did is in the fact's `check_reasons`.

The customer group is optional (rule 9). When it is a specific plural category (not a name,
not a bare word like "businesses", not a range) **and every word of it is in the quote**, it
fills the offer. Otherwise the offer and subject use their slot-free forms and the opener
still ships. "Our clients" and "business owners" are not specific. If a stored group breaks
a rule once it sits inside the offer, composition tries again without it and records that
it was set aside (`opening_detail.for_whom_dropped`). Until 1 October one word of the group anywhere on the page was enough, so
"regional food wholesalers" passed against a page that said only "wholesalers".

The peer label that fills `{peer_group}` is used only while the brief still holds that
exact label; otherwise the default label is used.

At composition, in code, again: the client's switch is on, the variant has lines from the
current brief, the fact was judged under the current version of the checks, the page is
still under 90 days old, and the finished email passes every template rule with the real
words in it (35 to 85 words, 15-word sentences and 22 for the offer, and the rest). The
reading grade is taken in two parts since 2 October: the email with the opener clause set
aside reads at grade 5 or under, and the opener sentence alone, names masked, at grade 16
or under. A prospect's own words for what they do are often long, and one long word in a
short sentence used to send a sound fact back to the template. Any failure sends the
template, and the reason is recorded.

**To replay stored clauses against the current checks** without paying for extraction:
`npx tsx scripts/run-firm-fact.ts --recheck <files> --must-fail <id prefix>=<added word>,...`.
The must-fail ids are controls, each with the word its clause is known to add. The run fails
unless each one is rejected by both the code check and the judge **for that word**. A judge
that gave no answer (the API down, a key at its limit) has tested nothing and fails the
control too: the first version read "no answer" as "the judge rejected it" and reported
success with the judge never consulted.

## The template rules of 1 October

Eleven operator rules, each enforced in code with a planted test. The per-client parts
live in the brief, so the checks name no market.

| Rule | Where it is enforced |
|---|---|
| 1. A consequence in a pain line is a possibility ("can", "often") | `findPainFormFaults` in the validator, on Email 1 pain lines and follow-up pain paragraphs. A sentence passes as a possibility, a question, or a report about other people whose content holds no "you"; the possibility word must be in what is said, not on "tell us". The kinds of each follow-up's paragraphs are fixed, so a paragraph cannot leave the rule by changing its label. The scope judge's `asserts_about_reader` holds the same rule as a judgement on pain and break-up lines |
| 2. A differentiator is an outcome or expertise, never a manual task | The brief's `avoid_wording` (the client's own list of task wording), and the scope judge's `manual_task` flag. There is no universal word list: for another client the paperwork is the product |
| 3. A question or call ask is its own paragraph | Validator, every email |
| 4. Only the lead differentiator may be proof in an Email 1 offer; each proof point once per sequence | Brief `lead_differentiator`; validator by `from`; scope judge by what a line uses (`proof_used`), so a proof point inside a question or a subject is seen. In Email 1 a proof point sits in the offer and nowhere else, and the subject counts as a use |
| 5. A pain is the symptom the reader feels, not a diagnosis | Brief `symptom` on every angle (the generator never sees the diagnosis); scope judge `self_diagnosis` |
| 6. One variant per lead angle; no narrow consequences | `variantKeysFor`; validator `variant_count` and `email1_angles_distinct`; `avoid_wording`; scope judge `narrow_consequence` |
| 7. A peer label is true of any in-scope buyer | `judgePeerDefaultLabel`: one model call per run, before anything is written. The brief validator's phrase match is the floor under it. Copy reviewer category `opener_pain_disconnect` (report mode) |
| 8. Two wordings per Email 1 line | `alt` on the line; tiers 2 and 3 rotate by prospect, tier 1 always uses wording 0; the wording that shipped is in `sent_sequences.opening_detail` |
| 9. Tier 2 ships whenever the fact passed | `decideFirmFactEmail1` |
| 10. Faithfulness | `findWordsAbsentFromQuote`, and the word-by-word judge |
| 11. An angle that conflicts with a "must not exclude" buyer is never used | Brief `conflicts_with`. The angle is never planned, never shown to the generator or the judge, and the validator refuses any line that cites it. Every exclusion the scope judge raises fails the variant, so a stored document is one the judge ran clean on |

**Why tier 1 never rotates wordings.** The stored Email 1 body is wording 0 of every line,
and the research writer, its judge and the follow-up fingerprint are all built on it.
Rotating the offer under a researched opening would put the opening above a line it was not
written for and discard generated follow-ups for about half of researched prospects.

**The neutral offer line.** One variant's offer carries `offer_angle: null`. The
offer-line selector gives that line to a researched opening that matches no tagged offer.
Without one, an unmatched opening gets a hash-picked offer about a specific problem, which
is the fault the selector was built to remove.

So that it names no one problem, it may sell only an outcome that answers **every** lead
pain (`neutralOutcomeIds`, validator rule `neutral_offer_outcome`). A brief with two or
more lead angles and no such outcome is refused when it is validated, with the angles
named. Until 1 October nothing held what the neutral line sold, and the stored "neutral"
line led with the outcome for one pain. The scope judge reads it like any other offer,
against its own variant's pain. (For a day it was also judged against every other lead
pain. That was wrong about where the line goes: a researched opening replaces the pain
paragraph, so the neutral line never sits under another variant's pain, and the judge
refused a sound line on every round.)

**Which variant carries it** (`neutralVariantIndex`). The lead angle whose own first answer
(`resolved_by[0]`) is an outcome that answers every lead angle. There the line is the
natural offer for its own pain and neutral for the others. It used to be the last variant
whatever its pain, and on the live client that put a growth outcome under a pain about
planning: the judge passed that pairing on one read and refused it on the next, because
the line did not really answer the pain above it. If no lead angle is answered first by a
common outcome, the last variant carries it as before. To move it, reorder `resolved_by` in
the brief.

## The rules of the second reading (1 October, evening)

Ten more operator notes, from the second reading file. Each is a rule in code with a planted
test, and the per-client parts live in the brief.

| Note | Where it is enforced |
|---|---|
| 1. An offer sells the outcome, never a feature | Brief `outcomes` (what the client achieves for the reader). Validator `offer_outcome`: every offer line cites an outcome. Scope judge `sells_outcome` (it was `leads_with_outcome` until the fourth reading put what we do first), shown the outcome the line cites, so a line cannot cite one outcome and end on another. The outcome a line cites also covers its outcome clause in the scope check. A feature may only appear as supporting proof. The generator is told to state the outcome as a possibility ("can"), never a promise: the earlier instruction to offer "what the reader can see or check" is gone, because it is what produced the transparency offer |
| 2. An offer answers the pain stated just above it | Brief `pain_angles[].resolved_by` (which outcomes answer which pain). Validator `offer_resolves_pain`: the outcome an offer cites must be one that pain is resolved by. Scope judge `resolves_pain`, shown the pain line above the offer |
| 3. No phrase that can be read two ways | `findAmbiguousReferents`: refused in the brief itself (where copy inherits it), in every rendered email, subject and frame (`ambiguous_referent`), and judged per line by the scope judge. The judge is told what is NOT ambiguous (a loose general statement, a word that points at the line just before it in the same email), and each line is sent with its place in the sequence. Its answer counts only when the phrase it quotes holds a word that points ("someone", "those", "it", "others"): it kept quoting phrases with nothing pointing in them. And it is set aside when it quotes the brief's own wording, matched as whole words within one sentence, and the quote carries a content word: a phrase made of pointing and joining words ("that", "it can", "to them") is never excused |
| 4. A personalised Email 1 is followed by a personalised Email 2 or 3 | `threadVerdict` at upload holds the prospect otherwise. The follow-up writer is shown only the fact Email 1 opened on. Follow-ups are written by the batch research path (both phases, including a reuse run) and by research run from the command line (`scripts/run-research.ts`). Research started from the dashboard's inline button does NOT write them, because the calls do not fit its time budget: those prospects are held at upload until the follow-up backfill has run. The backfill reaches stale copy, argues from the same approved reason, and names the prospects it cannot write for. ADR-064 |
| 5. Personalisation says what the event points to, per the approved trigger reasons | `resolveApprovedReason`: the writer argues from the approved sentence, verbatim. A fact with no approved reason behind it is not personalised. `checkBridgeStatesReason` reads the finished line back. AT UPLOAD, `openingReasonVerdict` holds a personalised Email 1 that was not written to one of the client's approved reasons as they read today, which is every opening written before the rule. ADR-065 |
| 6. Fewer pure templates: a fallback ladder | `decideFirmFactEmail1`: specific fact, then the broad line, then the template. `checkFirmKind` holds the broad line to the page. A line that names nothing is refused: what counts as naming nothing on THIS client's list comes from the brief (`generic_kind_words`, plus the default peer label's words, matched by inflection only), and a listed word about a firm's size, ownership, legal form, age or place does not make a kind specific ("a small business", "a mid-size company", "a start-up"). That is a word list, so a descriptor nobody listed still passes. Such a word is set aside only where it describes the firm: "private client services" and "young people" keep theirs. A kind is stored in the case of running prose ("a Design Consultancy" becomes "a design consultancy" when the page uses the word in lower case), so a Title Case kind is not mistaken for a name. The quote must SAY the kind (`kindInQuote`, at extraction and again at composition): its words stand together in the quote with "a", "an", "the" or a form of "be" in front (across describing words), and the noun phrase ends where the kind ends: a joining word, a comma, a slash or a bracket is not an ending by itself ("a web design" against "a web design and marketing agency" is refused). So a heading or the firm's own name is not a kind ("Northtown Board Search"), a recomposition is not a kind, and "a web design" against "a web design studio" is refused. A kind may not end on a joining word or an -ing word ("an IT consulting"), nor hold a word the page only ever capitalises. All of it is code: a question to the judge about whether a clause "reads as a sentence" was tried and withdrawn the same day, because the judge failed sound lines. A kind made only of words for "a firm" ("an independent provider", "an LLP") names nothing. The broad line reads "you run an HR consultancy" or "you are an executive coach": the VERB comes from the extraction and is stored with the kind, never guessed from the word's ending. Reason code on every tier 3 prospect |
| 7. Competitors are excluded before research | Brief `competitor_categories`. `screenCompetitors` in front of both research entry points. ADR-063 |
| 8. This client's brief leads with growth | Brief content (the ranks of the pain angles), not code |
| 9. Tier 2 reads a touch lower | `FACT_EMAIL1_MAX_FILLED_GRADE = 5`, measured at composition on the email with the peer label and customer group filled in and the opener clause set aside (`reading_grade_filled`); the opener sentence has its own cap (`opener_clause_grade`, 16). A firm fact that pushes the email over falls down the ladder. The same grade is taken at GENERATION on two plain invented fills (a short clause and the broad line) with EVERY peer label in the brief, so templates that leave no room for an ordinary prospect are refused before they are stored. Every label, not the longest: a short label of long words reads harder than a long one of short words |
| 10. Email 3's offer is never transparency; an ask is a full sentence | `followup_offer_scope` requires an outcome and a non-proof scope item in a follow-up offer. `findAskFragments` (`ask_fragment`) requires a question to open on its verb or question word; "Isn't that...?" and "At your firm, is that a problem?" pass, "How about a short call?" and "Worth a short call, do you think?" do not. The generator is told the same. The brief's `avoid_wording` holds the client's own word choices |

## The rules of the fourth reading (2 October)

Six operator notes on reading file 4, each a rule in code with a planted test. The
per-client parts live in the brief.

| Note | Where it is enforced |
|---|---|
| 1. An opener frame never judges or praises | `frame_judges` names praise words, for a plain message. `frame_words` is the rule that holds: the words a frame adds come from a closed list (`FRAME_WORDS`: can, see, tell, your, site, website, page, homepage, says, shows, from, on, that, the), stated word for word in the generator's prompt. A list of what to refuse let "Fan of how" and "Hats off:" through, and the first live run under it wrote "Know {does}.", which reads as an order |
| 2. Emails 2 and 3 carry the firm's name | `{company}`, a follow-up-only slot with a `slot_free` form. Email 2 names the firm in one paragraph and the Email 3 offer names it (`followup_company_missing`); `followup_slot`, `followup_slot_mix`, `company_possessive`, `company_outside_followups`. At composition `decideFollowupFills` renders the paragraph again with the name in, and only when the body it holds is, byte for byte, the slot-free rendering of the stored lines. The name is `companyShortName`'s: see below. `{for_whom}` is allowed in a follow-up and filled only from what Email 1 itself shipped |
| 3. Human tone | `stiff_wording` (`findStiffForms`): a written-out pair a person would contract ("it is", "is not", "do not") is refused in authored words. Not "let us", and not inside a wh-clause ("what it is that"). The scope judge is not asked about fragments on a break-up, which may open "No worries if ..." |
| 4. Consequences flow, and lean on what the brief says | `consequence_link`: every pain sentence after the first opens on a linking phrase. `consequence_from_brief`: every consequence holds a word of its angle's outcome, symptom or consequence in the brief, and an Email 1 pain's two wordings between them say every part of the brief's consequence. The second is what put "scale" into the emails: it was in the brief and in none of sixteen |
| 5. The offer is one flowing sentence | `offer_shape` (`offerShapeFaults`): one sentence, opens "We", and after its last joining word comes a clause that is no longer about the sender. Up to 22 words. This REVERSES the outcome-first shape built for note 1 of the second reading; that note's principle stands (an offer sells an outcome). `findThreePartList` sets a closing result aside and still reads what is left, so three things the sender does are refused however the sentence ends |
| 6. More prospects in tier 2 | The opener's own reading grade (`opener_clause_grade`), repair by removal (above), and the judge's question about meaning. Measured below |

**The firm's name in a sentence** (`src/lib/composition/company-short-name.ts`), as of the
fifth reading. Legal forms and generic business words come off the end ("Kessel Consulting
Ltd" is "Kessel") only when what is left holds a word that could only be this firm's: not a
place, nationality, weekday or month, not an everyday English word, not one of the client's
generic words, and not a word from the firm's own stored industry or keywords. Otherwise the
full name is said, because a full name is never wrong ("Summit Consulting", "North Texas
Advisors", "Institute of Consulting"). A name that is only a place or one everyday word
("Denver Ltd"), a record typed in capitals, the reader's own name, and a name that would end
on a small word ("of", "and", or any lower-case word) all become "your firm". Every word must
still be plain letters and digits (the earlier allow-list rule).

## The rules of the fifth reading (2 October)

| Note | Where it is enforced |
|---|---|
| 1. Build, don't check | The record-built line (`src/lib/sourcing/peer-kind.ts`). Written only when the provider's industry maps exactly to a peer group with a `kind` in the brief, AND the firm's own name holds one of the brief's `generic_kind_words` or a keyword is itself a short singular description of the kind ("management consulting"; never "software for consultants"). VETOED when our stored website reading names another kind of firm ("a recruitment agency", "an HR recruitment consultancy"). Carried only by a frame that does not name the site. (The pain line under it opened on `after_opener`, "Firms like yours", until 3 October; withdrawn, see below.) Ladder order: specific clause, kind from site, kind from record, slogan clause, template |
| 2. Short names | `companyShortName`, above. The firm's stored industry and keywords are passed in |
| 3. No repeats | `phrase_repeat` (a phrase at most twice per sequence) and `consecutive_word` (no word in two sentences in a row), in `src/lib/style/repetition.ts`, on every wording and on the firm-fact email. At composition the opener and the sentence under it may not share a word: the other wording is used, else the next rung |
| 4. Acronyms and slogans | Only HR, IT, AI, UK, US, USA, EU, UAE, CEO, B2B, B2C may appear (`KNOWN_ACRONYMS`). Any other short form refuses the clause or kind, read as the page writes it ("a pr agency" from a page saying "PR agency" is refused). Never repaired by deleting the acronym. Slogans (section `tagline`) are tried last at extraction and sit below the record-built line |
| 5. Right conversations | Brief v5 (client data, not code): outcome O4 "You have more conversations with the right buyers", voice rule V6 ("good-fit" at most once a sequence) |
| 6. Awkward phrasing | `ask_could`; the scope judge's `unnatural` question. "new clients can arrive steadily" and "Would a short call make sense?" are in the stored lines |

The templates of 2 October were finished by hand: three capped generator runs each ended a few
lines short under the repetition rules. The finished lines passed the validator and the scope
judge through the generator's keep path. See the Backlog.

**What is recorded.** `followups.slot_fills` on the composed sequence says, per position,
what went into the body or why it kept its stored wording (`nothing_held`, `no_slots`,
`body_is_not_a_stored_template`, `stored_body_differs_from_lines`, `filled_body_over_band`).
It is returned to the caller and not stored: the body as sent is in `sent_sequences.emails`.

## After reading file 6 (3 October)

Every rule here is universal: it holds for any client, and the client's own words come
from its brief. See ADR-067.

| Change | Where it is enforced |
|---|---|
| Named, conversational source | Every Email 1 pain wording names its source with `{peer_group}` mid-sentence ("When we chat to {peer_group}, a lot of them tell us ..."): `peer_group_source`. A faceless source ("Firms like yours", "Many firms", "Some firms", "businesses like you") is refused in every authored line: `findFacelessSource` in `validate-templates.ts`. `after_opener` is withdrawn and ignored |
| The reader's own group | Composition names the reader's peer group where known (the label is never swapped for a stand-in). On the peer and broad rungs the label's own words under the opener ("you run a software company", "software makers") are not a repeat; on the specific rung they still are, because there a label word is usually the reader's customers. `openerRepeats` in `firm-fact-email1.ts` |
| Lead-in, not assertion | Each Email 1 carries `lead_in`: "If {company} is seeing this too," (slot-free "If you're seeing this too,"), joined in front of the offer. At most 8 words, only `{company}` as a slot (`lead_in_missing`, `lead_in_shape`, `lead_in_slot`). Composition names it with the short name after Email 1 is fingerprinted, and only when the named email still fits its band |
| Consequence, question, outcome | The scope judge also asks: does the consequence follow from the pain (`consequence_follows`), does each question match its email (`question_matches`), does an offer imply the reader already has the outcome (`asserts_about_reader`). The personalised Email 1 floor also asks that the question tie back to the hook |
| Reading grade | The filled grade (`reading_grade_filled`, cap 5) no longer reads the peer label: it is masked like a slot, at generation and at composition. The label is the name of the reader's own trade, and graded in, the longer labels ("environmental consultants") put most wordings over the cap. Its length is still held by the length rules |
| Voice | The brief's `colloquialisms` (up to five, each at most five words) are exempt from the idiom list for that client only |
| Trigger definitions | Each ICP tier 1 trigger may carry `definition` (what counts, what does not). Synthesis is shown it, and `checkFactWithinDefinition` (Haiku, temperature 0) holds a chosen event outside it: `outside_definition`. Drafted per client by `scripts/propose-trigger-definitions.ts` as a pending ICP suggestion (wording only, so the search is untouched) |
| Scope on follow-ups | `followup-scope.ts`: any claim a personalised Email 2 or 3 makes about what the sender will do must fall within the brief's scope ("what we do", "never claim"). `fact-check-followups` is given the scope |
| Small fixes | Short names drop trailing descriptors and initialisms (places and trade words keep the full name); the opener says "you run" for a firm and "you are" only for a person (`kindVerbFor`); "Sept"-style month abbreviations are allowed |
| Upload hold | `organisations.outbound_upload_hold` and `_note`. `handleUploadLeads` refuses while it is on, and an unreadable hold counts as a hold. On for MargenticOS since 3 October; only the operator lifts it |

## Cost

Hard ceiling: **$0.02 per prospect**, both calls together, at full price. Held three ways:

1. Before sending: the request is token-counted. Too big, the page text is cut once; still
   too big, nothing is sent.
2. At build time: a test works out the worst case from the price table and the caps
   ($0.0196, with the broad line judged in the same call) and fails if it passes $0.02. A
   price change breaks the build, not the ceiling.
3. After the call: the real usage is priced. Over $0.02, the fact is thrown away, an error is
   logged, and `firm_fact_extraction` is switched off for every client until someone looks.

Measured on 30 September over about 100 extractions: about $0.007 each, the most expensive
$0.0116. Extraction runs inline at full price; the plan's batch route would halve it.

### Measured under checks version 15 (1 October 2026, night)

One run over the 77 template-bound MargenticOS prospects with website text, $0.73 in all,
the most expensive prospect $0.0140. No call was cut off or unreadable.

| | Version 11 | Version 12 | Version 13 | Version 14 | Version 15 |
|---|---|---|---|---|---|
| Passed at the specific rung | 24 | 26 | 28 | 25 | 24 |
| Passed at the broad rung | 12 | 5 | 6 | 7 | 7 |
| Paid calls cut off or unreadable | 0 | 4 | 2 | 0 | 0 |

The specific rung moves by about four between identical runs, so only the broad rung's
change is a finding: version 11 passed five broad lines the page never states as a kind
(four page titles or headings and the one with its noun missing), and version 12's judge
question refused sound ones. Versions 14 and 15 passed the same seven broad lines; 15
closed holes no real prospect in this cohort happened to hit. Whole cohort, by the free
census (`scripts/tier-census.ts`): of 82 template-bound prospects, 25 reach tier 2 (18
specific, 7 broad) and 57 get the template. Of the 57, 19 have no usable site or an
identity mismatch; 21 failed the form checks, 12 the faithfulness judge, and 5 were
refused once their words were in the email.

### Measured under checks versions 16 to 21 (2 October 2026)

Six runs over the same 77 prospects with website text, about $0.72 each, the most expensive
prospect $0.0153. No paid call was cut off or unreadable in versions 19 to 21.

| | 15 | 16 | 17 | 18 | 19 | 20 | 21 |
|---|---|---|---|---|---|---|---|
| Passed at the specific rung | 24 | 44 | 44 | 44 | 40 | 42 | 40 |
| Passed at the broad rung | 7 | 6 | 6 | 4 | 8 | 3 | 6 |

Version 16 is the loosening: repair by removal, the opener's own reading grade, and the
judge told that saying less is not saying something different. Versions 17 to 21 took
nothing away on purpose; each fixed faults read from the run before it or found by review
(a slogan passing as a clause, a cut that stopped mid-phrase, "M and A"). The total moves
by about three between identical runs (48, 45, 46 for versions 19 to 21), so those three
are one result.

Whole cohort, by the free census, against the templates of 2 October: of 82 template-bound
prospects **41 reach tier 2** (36 specific, 5 broad) and 41 get the template. It was 25 and
57 under version 15. Of the 41: 19 have no usable site (13 no website text, 5 a bot-check
page, 1 an identity mismatch), 19 failed the form checks, 1 the judge (it was 12), and 2
were refused once their words were in the email (it was 5). Of the 41 in tier 2, 31 use
the clause as the model wrote it, 5 a repaired one (4 first item, 1 cut), 5 the broad line.

What still fails the form checks, counting candidate clauses in the version 21 run: a
marketing word in the clause ("solutions", "leverage", 9), a word that is not in its quote
(9), a comma list whose first item does not stand (9), and a kind that names the work with
no noun for the firm ("an IT consulting", 6). The last is the one loosening left that looks safe: a third
form of the broad line for a FIELD of work. Not built. It changes a prompt, so it needs a
live trial against a baseline.

### Measured under checks version 23 (2 October 2026, night)

One run over the same 77 prospects with website text, $0.77, the most expensive prospect
$0.0152: 41 specific and 6 broad pass (49 under version 22). Opus costs are a third of
what this doc printed before this date: the price table said $15/$75 per million tokens,
and the published price is $5/$25.

Whole cohort by the free census, against the pending suggestion of 2 October with the tier
treated as on: of **280** prospects, 198 personalised, 33 a specific line from their site,
7 the kind of firm from their site, 30 the line built from their record, and **12 the plain
template (4.3%)**. Of the 26 not yet uploaded, 1 gets the plain template.

## What to check if it breaks

- **No prospect ever gets tier 2.** Look at `sent_sequences.opening_detail->>'reason'`.
  `tier_off` means the document's switch is off. `variant_has_no_lines` means the templates
  were written by the older messaging agent, which carries the brief forward but writes no
  lines. `fact_from_older_checks` means `FIRM_FACT_CHECKS_VERSION` was bumped since the fact
  was stored: run the backfill. `fact_did_not_pass` is the commonest and is by design.
  `fact_kind_does_not_read` means the only thing stored is a kind of firm with its noun
  left off ("an IT consulting"), which would not make a sentence; it is checked at
  composition as well as at extraction.
  `fact_not_specific` means the stored clause names nothing ("you provide professional
  services"), judged against the brief's `generic_kind_words` as they read today; that
  check runs at composition as well as at extraction, so it reaches facts stored before it
  existed, and a word added to the brief's list reaches them with no new extraction.
- **An upload reports leads "held, not sent".** Their Email 1 is personalised and neither
  follow-up is. The prospect's `outbound_upload_error` starts `personalised_without_followup`
  and says why for each position (none written, or written against a different Email 1).
  Run the follow-up backfill, then upload again. This happens to every personalised prospect
  when a new messaging document is approved, because the offer line under the opening changes.
  If a prospect is still held after the backfill, the backfill's closing list
  (`STILL HELD AT UPLOAD`) says why and what it needs. A hold is not always a one-day wait.
- **An upload reports leads held because the first email "was not written to one of this
  client's approved trigger reasons".** `outbound_upload_error` starts
  `opening_without_approved_reason`. The opening was written before that rule, or to a
  reason the client has since reworded or removed. The backfill cannot fix it. Run those
  prospects' research again. After the rule first ships this is EVERY personalised
  prospect researched before it.
- **An upload stops with "The approved trigger reasons are needed".** The read of the
  client's ICP failed. Nothing was uploaded and nothing is left claimed. Try again; it is
  never treated as "this client has no approved reasons".
- **A prospect vanished from research with the reason `competitor`.** The competitor screen
  excluded it. `prospects.competitor_check` holds what it rested on. If the category was
  drawn too wide, narrow it in the brief and run
  `scripts/run-competitor-screen.ts --rescreen-excluded --commit`. That restores a prospect
  whether the category was reworded, a phrase was removed, or the whole category was
  deleted, and prints each one under RESTORED.
- **Fewer personalised openings than before.** Look for `no_approved_reason` in
  `prospects.trigger_data->judge->>not_written_reason`, and on the client page's
  "writer stopped" list. The fact research selected matched none of the client's triggers
  that carry an approved reason. Either the trigger list needs a trigger for that kind of
  event, or the prospect is correctly not personalised.
- **The reason is `brief_invalid`.** A brief is in the document and no longer passes
  `validateOutboundBrief`, usually because a field was added to the brief's shape since it
  was stored. The problems are recorded beside the reason and logged at warn. The client's
  tier 2 and wording rotation are off for every prospect until the brief is corrected and
  the templates regenerated.
- **MON-033 raises after a document loses a variant.** Expected. Research and composition
  both record which variant a prospect left when the document no longer has it.
- **Tier 3 emails never rotate wordings.** `opening_detail->>'wording_not_rotated'` says
  why. `stored_body_differs_from_lines` means the stored Email 1 and its lines have drifted
  apart; regenerate the templates.
- **Extraction has stopped for everyone.** `system_flags.firm_fact_extraction` is false. A
  prospect cost more than $0.02. Read the error, find out which assumption broke, then
  switch it back on by hand.
- **A check was tightened and old facts still ship.** Bump `FIRM_FACT_CHECKS_VERSION` in
  `firm-fact-checks.ts` (read the number there; this file went five versions stale in a day by quoting it). A stored fact is a frozen verdict; the version is what
  makes a rule change reach it. The "names nothing" check is also re-run at composition on
  the stored words, which covers a TIGHTENING of that one check. It does not cover a
  loosening: a fact stored as failed keeps no words to re-read, so only a new extraction
  reaches it.
- **The generator fails on `reading_grade_filled`.** With one of the client's peer labels
  filled in (the message names which) and the opener clause set aside, Email 1 reads above
  grade 5. The pain, offer and question need shorter words, or that peer label is itself
  hard to read. The cap is close: on 2 October "steadily" in place of "steady" took one
  variant from under 5 to 5.01.
- **The generator fails on `consequence_from_brief`.** A consequence line says something the
  brief's consequence for that angle does not, or the two wordings of an Email 1 pain leave
  a part of it unsaid. The message quotes the part. If the brief's consequence is wrong,
  change the brief.
- **Emails 2 and 3 say "your firm" where a name was expected.** Read
  `followups.slot_fills` on the composed sequence. `nothing_held` means the name on the
  record is not one a sentence can carry (see "The firm's name in a sentence").
  `body_is_not_a_stored_template` means the follow-up is a personalised one, or the
  variant's lines are from an older brief. `stored_body_differs_from_lines` means the
  stored body and its lines have drifted: regenerate the templates.
- **The scope judge says a line "states N4" (or another never-claim) for the client's own
  wording.** On 2 October it read "We run outbound", which is the brief's own scope item
  almost word for word, as a claim of calling on three reads of seven, and never on the same
  words in another variant. It costs a repair round and the line is reworded. On the
  Backlog.
- **The brief is refused with "no outcome answers every lead angle".** The neutral offer
  line needs one outcome listed under `resolved_by` of each lead angle. Add it in the brief.
- **The brief is refused for `generic_kind_words`.** The list is required and may be empty.
  It holds the words true of every firm the client writes to: one lower-case word each, of
  letters or digits, at least two characters, no hyphen. An entry covers its own plural and
  verb endings and nothing else, so "consulting" and "consultancy" are two entries. A brief
  stored before this field existed must be landed again with it; until then the client's
  tier 2 and wording rotation are off and the reason recorded is `brief_invalid` with the
  field named.
- **The brief is refused because an outcome or a pain "holds a phrase the brief forbids".**
  A never-claims, must-not-exclude or avoid-wording phrase sits inside an outcome, a
  symptom or a consequence. The generator is told to use those words and the validator
  refuses them, so every variant would fail on every round. Change one or the other.
- **The generator fails with "N of M variants passed".** Read the reasons it prints. Rerun
  with the `--keep ... --keep-from ...` command it prints. A variant that fails the scope
  judge every time usually means two items in the brief pull against each other.
- **The generator stops on the peer label.** The default peer label names a narrower group
  than the buyers the brief says are in scope. Change `peer_group_default` in the brief.
- **The dashboard's approve step drops the brief.** It should not: the approve path promotes
  the whole content. If a later run of the OLD messaging agent drops it, check
  `carriedOutboundSections` in `messaging-generation-agent.ts`.

## Why the key decisions were made

- **A brief, not the strategy documents.** The generator used the documents faithfully and
  the documents were wrong for outbound. Fixing the generator could not fix that.
- **One set of renderers.** The validator, composition and the reading files all build
  emails through `template-shape.ts`, so what is validated is what ships.
- **Stored bodies stay slot-free.** The research writer and existing composition read
  `variants[X].emails[n].body` exactly as before; the structured lines sit beside them.
- **Two model calls for extraction, not one.** A model checking its own paraphrase agrees
  with itself.
- **Fail closed, always to the template.** Nothing here can make an email worse than what the
  prospect would have received anyway.

## Known limits (see Deferred on the Notion Backlog)

- The faithfulness judge was lenient: on 30 September it passed "automation systems" against
  a quote that said "systems". Since 1 October the code check catches every such word before
  the judge is called, and the judge audits word by word. Two real clauses are must-fail
  controls for `--recheck`. The plan's labelled control set of about 40 clauses is still
  the proper instrument and is still not built.
- Tier 2 yield is half (41 of 82 on 2 October; it was 25). 22 prospects have a usable site
  and still get the template.
- A repaired clause can be broader than the page: a limit left off. The judge is told a
  left-off ending is not twisting, by measurement, so nothing holds this but the refusal to
  cut a clause that fences its claim in. True and broader, never the opposite.
- The repairs recognise a noun by the FORM of the word (a plural, or an ending nouns have).
  A sound cut ending on "roadmap", "process" or "advice" is not taken.
- A word the page capitalises between two lower-case words is kept as a name ("HR services
  and Advisory support"). A stray capital, never a wrong word. Pinned as a test.
- "Only says things get better" is a word list. An unlisted word for it still passes.
- The firm's name: a trade word or acronym on no list, and not in the firm's own record, is
  still said alone ("Analytics Consulting" is "Analytics"). A short acronym cannot be told
  from a short name.
- The record-built line still passes a recruiter or broker whose own NAME holds the evidence
  word, and a singular product noun as a keyword ("robo advisor"). Read the names on this
  rung before an upload (Backlog, Live risk).
- Three single-word corrections in the templates of 2 October were made by hand and put
  back through the validator and the judge ("No worries", "at a steady pace", "the wrong
  ones"). The grade-5 cap and the 15-word sentence cap each pushed the writer to drop a
  syllable or an article.
- The broad rung is held by rules about the FORM of what the page writes, and three rounds
  of review each found a shape the rules missed. The remaining known ones are on the
  Backlog: a quote that negates the kind or is about a customer ("We are not a law firm",
  "software for the modern dental practice") passes the code check and rests on the judge;
  a place or a brand the model writes in lower case passes the name check; trade words on
  the praise, time and number lists refuse whole trades in other markets.
- The broad line's VERB ("you run" or "you are") is the extraction model's choice. Nothing
  in code checks it is the right one. Every stored verb in the version 14 run read
  correctly (11 of 11).
- A kind stated without an article is refused ("Award-winning print shop." as a tagline),
  because the same shape is a heading or a firm's name. Four real prospects on 1 October.
- The dashboard does not show a line's second wording. The reading files do. An operator
  approving a messaging suggestion in the dashboard sees wording 0 only.
- Sequence coherence acts on the angle the OFFER LINE declares. A researched opening can be
  about a different pain than its variant's offer, and then a template follow-up can repeat
  it. Detecting that by word overlap was measured and does not work (a true repeat scored
  0.13, a non-repeat 0.14). It needs a tag written at research time.
- Idioms are caught twice: by a list in the validator, and by the scope judge, which says
  per line whether it holds a figure of speech. Added after the first real run under the
  eleven rules shipped three past the list.
- The word check treats an -ing noun and its verb as one word ("marketing" and "market").
  Telling them apart needs the part of speech. The judge is the second gate on those.
- Rule 1 reads the form of a sentence. "As you can see" would satisfy it with "can".
- The peer label judge reads the DEFAULT label only. A named peer group's label is checked
  per prospect by the faithfulness judge (`peer_group_supported`).
- The competitor screen asks about a company only when the data provider's record carries
  one of the brief's phrases. A competitor whose record carries none is not caught before
  research. A prospect uploaded before the screen existed is never screened.
- The approved-reason rule resolves a stored trigger by its POSITION in the client's list. A
  list whose triggers were reordered would hand an older research row another trigger's
  reason. Nothing detects that.
- The rules of the second reading that govern TEMPLATE lines (outcome, pain match, full
  asks) do not run on a personalised follow-up, which is written by a different writer
  with its own gates.
- The research writer's own prompt still carries worked examples written before the
  approved-reason rule. The rule is applied by the brief the writer is handed and by the
  check on what it wrote, not by rewriting that prompt.
