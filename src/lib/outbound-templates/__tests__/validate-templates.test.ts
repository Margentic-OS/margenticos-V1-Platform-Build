// Every check in the template validator, proven to RUN by a planted fault.
//
// THE CONTROL COMES FIRST. The invented document must pass with zero violations. A
// validator that returned nothing for everything would pass that test too, which is why
// every rule below is also planted and must fire: the pair together proves the rule both
// runs and does not over-fire on good copy. (Round 6 finding: a drafting harness silently
// ran no peer-group or number checks on follow-ups, and only a planted control caught it.)

import { describe, it, expect } from 'vitest'
import {
  findAskFragments, findAssertedConsequences, findConsequencesOffTheBrief, findPainFormFaults, findThreePartList, findUnlinkedConsequences,
  unsaidConsequenceParts,
  offerShapeFaults, openerClauseGrade, validateFactEmail1, validateTemplateDocument,
  OFFER_MAX_SENTENCE_WORDS, OPENER_CLAUSE_MAX_GRADE, type TemplateViolation,
} from '../validate-templates'
import {
  INVENTED_OPENER_FRAMES,
  INVENTED_SIGNOFF,
  inventedBrief,
  inventedVariants,
} from './fixtures/invented-client'
import { renderEmail1SlotFree, renderFactEmail1, renderFollowup, renderFollowupSlotFree, type TemplateLine, type VariantLines } from '../template-shape'
import type { OutboundBrief } from '@/lib/outbound-brief/brief'
import { OUTBOUND_TEMPLATE_SYSTEM_PROMPT } from '@/agents/outbound-template-agent'
import { findAmbiguousReferents } from '@/lib/style/ambiguous-referent'

type Doc = {
  brief: OutboundBrief
  opener_frames: string[]
  variants: Record<string, VariantLines>
}

function baseDoc(): Doc {
  return { brief: inventedBrief(), opener_frames: [...INVENTED_OPENER_FRAMES], variants: inventedVariants() }
}

function run(doc: Doc): TemplateViolation[] {
  return validateTemplateDocument({ ...doc, signoff: INVENTED_SIGNOFF })
}

/**
 * Rewrite a follow-up paragraph as a plain one. Several paragraphs of the fixture name the
 * reader's firm and so carry a slot_free form, which is what the slot-free body renders: a
 * planted fault written into `text` alone would sit in a form no slot-free prospect reads.
 */
function setPlain(p: TemplateLine, text: string): void {
  p.text = text
  p.slots = []
  p.slot_free = null
}

function rulesAfter(mutate: (doc: Doc) => void): string[] {
  const doc = baseDoc()
  mutate(doc)
  return run(doc).map(v => v.rule)
}

describe('validateTemplateDocument', () => {
  it('passes the invented document with zero violations (the control)', () => {
    expect(run(baseDoc())).toEqual([])
  })

  // Each entry: rule name, and a mutation that must make exactly that rule fire.
  const planted: Array<[string, (doc: Doc) => void]> = [
    ['dash', d => { d.variants.A.email1.question.text = 'Is losing buyers abroad a problem — right now?' }],
    ['ampersand', d => { d.variants.A.followups[0].paragraphs[0].text = 'Exporters often tell us sales & growth take longer than planned.' }],
    ['ai_tell', d => { d.variants.A.followups[0].paragraphs[0].text = 'Exporters often tell us a robust market takes longer than planned.' }],
    ['jargon', d => { d.variants.A.followups[0].paragraphs[0].text = 'Exporters often tell us the go-to-market takes longer than planned.' }],
    ['firmographic', d => { d.variants.A.followups[0].paragraphs[0].text = 'Exporters with a team of 12 often tell us a market is slow.' }],
    ['forbidden_phrase', d => { setPlain(d.variants.A.followups[1].paragraphs[1], 'We check every page and avoid machine translation.') }],
    ['sentence_length', d => { d.variants.A.followups[0].paragraphs[0].text = 'Exporters often tell us a new market takes a great deal longer than they had first planned for.' }],
    ['paragraph_sentences', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams wait. The pages are in one language. Growth slows.' }],
    ['paragraph_words', d => { d.variants.A.followups[0].paragraphs[1].text = 'So sales teams can wait for pages that are still written in just a single language of their own. Then growth often slows right down while the whole sales team just sits and waits for them.' }],
    ['i_opener', d => { d.variants.A.followups[0].paragraphs[0].text = 'I hear from exporters that a new market takes longer than planned.' }],
    ['reading_grade', d => { d.variants.A.followups[0].paragraphs[1].text = 'Organisational internationalisation initiatives necessitate comprehensive multilingual documentation.' }],
    ['question_count', d => { d.variants.A.followups[2].paragraphs[1].text = 'If buyers abroad become a priority, can we pick this up?' }],
    ['breakup_explains', d => { d.variants.A.followups[2].paragraphs[0].text = 'I wrote because pages matter.' }],
    ['word_band', d => { d.variants.A.followups[0].paragraphs = d.variants.A.followups[0].paragraphs.slice(2) }],
    ['noticed_opener', d => { d.opener_frames[0] = 'I noticed {does}.' }],
    ['noticed_opener', d => { d.opener_frames[0] = 'Saw that {does}.' }],
    ['back_reference', d => { d.variants.A.email1.offer.text = 'We fix those pages for {for_whom} abroad. We check each page with a native speaker.' }],
    ['assumed_capacity', d => { d.variants.A.email1.question.text = 'Is your week too full to fix pages for buyers abroad?' }],
    ['slot_undeclared', d => { d.variants.A.email1.subject.slots = [] }],
    ['slot_unknown', d => { d.variants.A.email1.question.text = 'Is {their_market} a problem for you right now?' }],
    ['does_outside_opener', d => { d.variants.A.email1.offer.text = 'We translate pages when {does}.'; d.variants.A.email1.offer.slots = ['does'] }],
    ['followup_slot', d => { d.variants.A.followups[0].paragraphs[0].text = '{peer_group} often tell us a new market takes longer than planned.'; d.variants.A.followups[0].paragraphs[0].slots = ['peer_group'] }],
    ['slot_free_missing', d => { d.variants.A.email1.offer.slot_free = null }],
    ['slot_free_has_slot', d => { d.variants.A.email1.subject.slot_free = '{for_whom} again' }],
    ['from_missing', d => { d.variants.A.email1.question.from = [] }],
    ['from_unknown', d => { d.variants.A.email1.question.from = ['PA99'] }],
    ['frame_count', d => { d.opener_frames = ['Your site says {does}.'] }],
    ['frame_slot', d => { d.opener_frames[1] = 'From your site, {does} for {for_whom}.' }],
    ['frame_hedge', d => { d.opener_frames[1] = 'Looks like {does}.' }],
    ['frame_sentences', d => { d.opener_frames[1] = 'I read your site. It says {does}.' }],
    ['angle_reach', d => { d.variants.A.email1.angle = 'PA3'; d.variants.A.email1.pain.from = ['PA3'] }],
    ['angle_citation', d => { d.variants.A.email1.pain.from = ['PA2'] }],
    ['proof_as_pain', d => { d.variants.A.email1.pain.from = ['PA1', 'PR1'] }],
    ['peer_group_subject', d => { d.variants.A.email1.pain.text = 'Firms often tell us buyers abroad leave the site. They cannot read the pages, so sales stall.'; d.variants.A.email1.pain.slots = [] }],
    ['pain_number', d => { d.variants.A.email1.pain.text = '{peer_group} often tell us two buyers abroad leave the site. They cannot read the pages.' }],
    ['pain_duration', d => { d.variants.A.email1.pain.text = '{peer_group} often tell us buyers abroad leave within a week. They cannot read the pages.' }],
    ['pain_absolute', d => { d.variants.A.email1.pain.text = '{peer_group} often tell us buyers abroad always leave. They cannot read the pages.' }],
    ['offer_scope', d => { d.variants.A.email1.offer.from = ['D2', 'PR1'] }],
    ['meeting_request', d => { d.variants.A.email1.question.text = 'Is a short call about buyers abroad useful?' }],
    ['angle_unknown', d => { d.variants.A.followups[0].angle = 'PX' }],
    ['angle_distinct', d => { d.variants.A.followups[0].angle = 'PA1' }],
    ['breakup_angle', d => { d.variants.A.followups[2].angle = 'PA2' }],
    ['email3_longer', d => { d.variants.A.followups[1].paragraphs[2].text = 'Would a short call next to see if this fits be useful to you?' }],
    ['email1_angles_distinct', d => { d.variants.B.email1.angle = 'PA1'; d.variants.B.email1.pain.from = ['PA1']; d.variants.B.followups[1].angle = 'PA2'; d.variants.B.followups[2].angle = 'PA1' }],
    ['brief_version', d => { d.variants.A.brief_version = 2 }],
    ['subject_length', d => { d.variants.A.email1.subject.slot_free = 'buyers abroad who cannot read your website pages' }],
    ['three_part_list', d => { setPlain(d.variants.A.followups[1].paragraphs[1], 'We translate pages, check them and send them back.') }],
    ['slot_policy', d => { d.variants.A.email1.offer.text = d.variants.A.email1.offer.slot_free!; d.variants.A.email1.offer.slots = [] }],
    ['idiom', d => { d.variants.A.followups[2].paragraphs[1].text = 'If buyers abroad matter down the road, reply and we can pick this up.' }],
    // Reads two ways: buyers arriving unevenly, or buyers leaving.
    ['idiom', d => { d.variants.A.followups[0].paragraphs[0].text = 'Exporters often tell us buyers abroad come and go.' }],
    ['email1_sentence_reuse', d => { d.variants.B.email1.question.text = d.variants.A.email1.question.text }],
    ['subject_reuse', d => { d.variants.B.email1.subject = { ...d.variants.A.email1.subject } }],
    ['offer_angle_missing', d => { delete (d.variants.A.email1 as { offer_angle?: unknown }).offer_angle }],
    ['offer_angle_length', d => { d.variants.A.email1.offer_angle = 'buyers in other countries leave the pages of your website because they cannot read them' }],
    ['offer_angle_neutral_count', d => { d.variants.A.email1.offer_angle = null }],
    ['neutral_offer_names_pain', d => { d.variants.B.email1.offer.from = ['D1', 'PA2'] }],
    // The neutral line sits under ANY lead pain, so it sells only an outcome that answers
    // all of them. O2 answers the neutral variant's own pain and no other lead pain.
    ['neutral_offer_outcome', d => { d.variants.B.email1.offer.from = ['D1', 'O2'] }],
    ['neutral_offer_outcome', d => { d.variants.B.email1.offer.alt!.from = ['D1', 'O1', 'O2'] }],
    // Graded with the fill in, at generation, for the plain cells: this sentence passes the
    // masked grade and tips the filled one over with the longest peer label.
    ['reading_grade_filled', d => { d.brief.peer_groups[1].label = 'international furniture manufacturers' }],
    ['frame_dropped_subject', d => { d.opener_frames[1] = 'Read that {does}.' }],
    ['question_points_back', d => { d.variants.A.email1.question.text = 'Would that be useful for you right now?' }],
    // ── Operator rules of 2026-10-01 ──
    // Rule 1: a consequence is a possibility, in Email 1 and in a follow-up pain paragraph.
    ['consequence_asserted', d => { d.variants.A.email1.pain.text = '{peer_group} often tell us buyers abroad leave the site. Sales stall when they cannot read the pages.' }],
    ['consequence_asserted', d => { d.variants.A.email1.pain.alt!.text = '{peer_group} say buyers abroad often leave pages in the wrong language. Sales abroad slow as a result.' }],
    ['consequence_asserted', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams wait a long time for pages in the local language. Growth slows while they wait.' }],
    // Stated in the prompt since Round 7, held by nothing until a run wrote it four times.
    ['busy_wording', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait a long time when the office gets busy. Growth often slows while they wait.' }],
    ['busy_wording', d => { d.variants.A.email1.pain.alt!.text = '{peer_group} say buyers abroad often leave during busy spells. Sales abroad can slow as a result.' }],
    // {for_whom} is the offer's and the subject's: a pain or question using it has a second,
    // separately written form that no pain or question rule reads.
    ['for_whom_outside_offer', d => { d.variants.A.email1.pain = { ...d.variants.A.email1.pain, text: '{peer_group} often tell us {for_whom} can leave the site.', slots: ['peer_group', 'for_whom'], slot_free: 'Buyers abroad always leave the site. Your sales stall when they cannot read the pages.' } }],
    ['for_whom_outside_offer', d => { d.variants.A.email1.question.alt = { text: 'Do {for_whom} leave your site before they buy?', slots: ['for_whom'], slot_free: 'Is a short call about buyers abroad useful?', from: ['PA1'] } }],
    // One line is one paragraph.
    ['line_break', d => { setPlain(d.variants.A.followups[0].paragraphs[2], 'Growth slows while they wait.\n\nDoes that match what you see?') }],
    ['line_break', d => { d.variants.A.email1.question.text = 'Buyers abroad can leave fast.\n\nIs losing buyers abroad a problem for you right now?' }],
    // An offer paragraph rests on scope or proof.
    ['followup_offer_scope', d => { d.variants.A.followups[1].paragraphs[1].from = ['PA3'] }],
    // The subject: lower case, no idiom, and the rules already planted for dash and phrases.
    ['subject_case', d => { d.variants.B.email1.subject.text = 'New markets' }],
    ['assumed_capacity', d => { d.variants.B.email1.subject.text = 'new buyers on your calendar' }],
    ['idiom', d => { d.variants.B.email1.subject.text = 'new markets down the road' }],
    ['ampersand', d => { d.variants.B.email1.subject.text = 'new markets & growth' }],
    ['jargon', d => { d.variants.B.email1.subject.text = 'your go-to-market abroad' }],
    // Checks that had no plant of their own.
    ['question_count', d => { d.variants.A.email1.question.text = 'Tell me if losing buyers abroad is a problem.'; d.variants.A.email1.question.alt!.text = 'Say so if buyers abroad leave your site.' }],
    ['noticed_opener', d => { d.variants.A.email1.offer.text = 'We noticed pages for {for_whom} abroad. A native speaker checks each page.'; d.variants.A.email1.offer.slot_free = 'We noticed pages for buyers abroad. A native speaker checks each page.' }],
    ['slot_policy', d => { d.brief.slot_policy = { for_whom_in_offer: false, source: 'invented' } }],
    ['line_missing', d => { d.variants.A.email1.question.text = ' ' }],
    ['shape', d => { (d.variants.A as { followups?: unknown }).followups = undefined }],
    ['shape', d => { d.variants.A.followups.pop() }],
    ['offer_angle_form', d => { d.variants.A.email1.offer_angle = 'buyers abroad -- leave pages' }],
    // ── The second reading's notes (2026-10-01) ──
    // Note 1: an offer sells an outcome. It cites one, in Email 1 and in a follow-up.
    ['offer_outcome', d => { d.variants.A.email1.offer.from = ['D1', 'PR1'] }],
    ['offer_outcome', d => { d.variants.A.email1.offer.alt!.from = ['D1', 'PR1'] }],
    ['offer_outcome', d => { d.variants.A.followups[1].paragraphs[1].from = ['D1'] }],
    // Note 2: and the outcome it cites answers the pain just above it.
    ['offer_resolves_pain', d => { d.variants.A.email1.offer.from = ['D1', 'PR1', 'O2'] }],
    ['offer_resolves_pain', d => { d.variants.B.followups[1].paragraphs[1].from = ['D1', 'PR1', 'O2'] }],
    // Notes 1 and 10: transparency is never the offer. A proof-only item cannot carry one.
    ['followup_offer_scope', d => { setPlain(d.variants.A.followups[1].paragraphs[1], 'You can see the status of every page.'); d.variants.A.followups[1].paragraphs[1].from = ['D2', 'PR2', 'O1'] }],
    // Note 3: no word that points at somebody without saying who.
    ['ambiguous_referent', d => { d.variants.A.followups[1].paragraphs[0].text = 'Some firms tried free tools first and the work went to someone else.' }],
    ['ambiguous_referent', d => { d.variants.A.email1.pain.alt!.text = '{peer_group} say buyers abroad often leave pages in the wrong language. Sales can go to others.' }],
    ['ambiguous_referent', d => { d.variants.B.email1.subject.text = 'new markets go elsewhere' }],
    // Note 10: an ask is a full sentence.
    ['ask_fragment', d => { d.variants.A.followups[1].paragraphs[2].text = 'Worth a short call?' }],
    ['ask_fragment', d => { d.variants.A.email1.question.alt!.text = 'Buyers abroad leaving your site?' }],
    ['ask_fragment', d => { d.variants.A.followups[1].paragraphs[2].text = 'How about a short call?' }],
    ['ambiguous_referent', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait a long time for pages. Growth can go to other people.' }],
    ['ambiguous_referent', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait a long time for pages. The work can go to someone.' }],
    // Rule 2: task wording is the CLIENT'S list (avoid_wording), never a universal one.
    ['forbidden_phrase', d => { d.brief.avoid_wording[0].phrases.push('write down'); setPlain(d.variants.A.followups[1].paragraphs[1], 'We write down the terms your sales team uses most.') }],
    // The follow-up pain rules the prompt has always stated, now held (was Email 1 only).
    ['pain_number', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait for two pages in the local language. Growth often slows while they wait.' }],
    ['pain_duration', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait weeks for pages in the local language. Growth often slows while they wait.' }],
    ['pain_absolute', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait a long time for every page. Growth often slows while they wait.' }],
    // A line with no {for_whom} has ONE form. A second form was what the stored body shipped
    // while the pain rules read the first.
    ['slot_free_unneeded', d => { d.variants.A.email1.pain.slot_free = 'Buyers abroad always leave the site within two weeks. Sales stall when they cannot read the pages.' }],
    // The subject: its length in the form that ships, and its words.
    ['subject_length', d => { d.variants.B.email1.subject = { text: '{peer_group} and slow growth in new markets abroad', slots: ['peer_group'], slot_free: null, from: ['PA2'] } }],
    ['forbidden_phrase', d => { d.variants.B.email1.subject.text = 'instant pages' }],
    ['forbidden_phrase', d => { d.variants.B.email1.subject.text = 'hiring for new markets' }],
    ['dash', d => { d.variants.B.email1.subject.text = 'new markets -- slow' }],
    // Rule 4 over the whole of Email 1: proof sits in the offer only, and the subject counts.
    ['proof_in_email1', d => { d.variants.A.email1.question.from = ['PA1', 'PR2'] }],
    ['proof_in_email1', d => { d.variants.A.email1.subject.alt!.from = ['PA1', 'PR1'] }],
    ['proof_repeated', d => { d.variants.A.email1.subject.from = ['PA1', 'PR1'] }],
    // The kinds of each follow-up are fixed: a paragraph cannot leave the pain rules by
    // changing its label.
    ['paragraph_structure', d => { d.variants.A.followups[0].paragraphs[1].kind = 'offer' }],
    ['paragraph_structure', d => { d.variants.A.followups[0].paragraphs[0].kind = 'close'; d.variants.A.followups[0].paragraphs[1].kind = 'close' }],
    ['paragraph_structure', d => { d.variants.A.followups[2].paragraphs[0].kind = 'offer' }],
    ['paragraph_structure', d => { d.variants.A.followups[1].paragraphs.shift() }],
    // Rule 11, wherever the angle is cited, not only where the plan put it.
    ['angle_conflict', d => { d.variants.A.followups[0].paragraphs[1].from = ['PA2', 'PA4'] }],
    ['angle_conflict', d => { d.variants.A.email1.offer.from = ['D1', 'PR1', 'PA4'] }],
    // Rule 3: the question or call ask is its own paragraph.
    ['question_own_paragraph', d => { setPlain(d.variants.A.followups[1].paragraphs[1], 'We translate the pages your sales team sends most. Worth a short call?'); d.variants.A.followups[1].paragraphs[1].kind = 'ask'; d.variants.A.followups[1].paragraphs.pop() }],
    ['question_own_paragraph', d => { d.variants.A.email1.question.text = 'Buyers abroad can leave fast. Is that a problem for you right now?' }],
    // Rule 4: proof in an Email 1 offer only when it is the lead differentiator, and once per sequence.
    ['proof_in_email1_offer', d => { d.variants.A.email1.offer.from = ['D1', 'PR2'] }],
    ['proof_in_email1_offer', d => { d.variants.A.email1.offer.alt!.from = ['D1', 'D2'] }],
    ['proof_repeated', d => { d.variants.A.followups[1].paragraphs[1].from = ['D1', 'PR1'] }],
    // Rule 6: one variant per lead angle.
    ['variant_count', d => { d.variants.C = JSON.parse(JSON.stringify(d.variants.A)) }],
    // Rule 8: two wordings per line, and they are two wordings.
    ['alt_missing', d => { delete d.variants.A.email1.pain.alt }],
    ['alt_missing', d => { d.variants.A.email1.offer.alt = null }],
    ['alt_identical', d => { d.variants.A.email1.question.alt!.text = d.variants.A.email1.question.text }],
    ['email1_sentence_reuse', d => { d.variants.B.email1.offer.text = d.variants.A.email1.offer.text; d.variants.B.email1.offer.slot_free = d.variants.A.email1.offer.slot_free }],
    ['subject_reuse', d => { d.variants.A.email1.subject.alt!.text = 'new markets' }],
    ['followup_alt', d => { d.variants.A.followups[0].paragraphs[0].alt = { text: 'Another wording here.', slots: [], slot_free: null, from: ['PA2'] } }],
    ['slot_policy', d => { d.variants.A.email1.offer.alt!.text = d.variants.A.email1.offer.alt!.slot_free!; d.variants.A.email1.offer.alt!.slots = [] }],
    // Paragraph kinds are what let the pain rules reach a follow-up.
    ['paragraph_kind', d => { delete d.variants.A.followups[0].paragraphs[0].kind }],
    ['ask_kind_mismatch', d => { d.variants.A.followups[0].paragraphs[2].kind = 'close' }],
    ['ask_kind_mismatch', d => { d.variants.A.followups[0].paragraphs[0].kind = 'ask' }],
    ['proof_as_pain', d => { d.variants.A.followups[0].paragraphs[0].from = ['PA2', 'PR2'] }],
    ['angle_citation', d => { d.variants.A.followups[0].paragraphs.forEach(p => { p.from = ['PA3'] }) }],
    // Rule 11: an angle that conflicts with an in-scope buyer is never used.
    ['angle_conflict', d => { d.variants.A.followups[1].angle = 'PA4'; d.variants.A.followups[1].paragraphs[0].from = ['PA4'] }],
    // The client's own avoid_wording reaches the copy.
    ['forbidden_phrase', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait a long time for pages. Hiring often slows while they wait.' }],
    // ── The fourth reading's notes (2026-10-02) ──
    // Note 1: a frame says what was seen and never judges it.
    ['frame_judges', d => { d.opener_frames[1] = 'Good to see {does}.' }],
    ['frame_judges', d => { d.opener_frames[1] = 'Great that {does}.' }],
    ['frame_judges', d => { d.opener_frames[0] = 'Impressed that {does}.' }],
    ['frame_judges', d => { d.opener_frames[1] = 'Interesting that {does}.' }],
    // A frame's own words come from a closed list: praise in a word nobody listed, and a
    // bare verb that reads as an order, both passed until 2026-10-02.
    ['frame_words', d => { d.opener_frames[1] = 'Know {does}.' }],
    ['frame_words', d => { d.opener_frames[1] = 'Fan of how {does}.' }],
    ['frame_words', d => { d.opener_frames[1] = 'Thrilled that {does}.' }],
    ['frame_words', d => { d.opener_frames[1] = 'Rare to see {does}.' }],
    ['frame_words', d => { d.opener_frames[0] = 'Hats off: {does}.' }],
    // Note 3: a written-out pair reads like a form letter, in any email.
    ['stiff_wording', d => { d.variants.A.followups[2].paragraphs[0].text = 'It is fine if buyers abroad are not a priority right now.' }],
    ['stiff_wording', d => { d.variants.B.email1.pain.text = '{peer_group} often tell us a new market grows slower than planned. When pages are not in the local language, that can happen.' }],
    ['stiff_wording', d => { d.variants.A.followups[1].paragraphs[0].text = 'Some firms tried free tools first and buyers did not trust the pages.' }],
    ['stiff_wording', d => { d.opener_frames[1] = 'It is clear {does}.' }],
    // Note 4: a consequence opens on a linking phrase.
    ['consequence_link', d => { d.variants.A.email1.pain.text = '{peer_group} often tell us buyers abroad leave the site. Sales abroad can stall.' }],
    ['consequence_link', d => { d.variants.A.email1.pain.alt!.text = '{peer_group} say buyers abroad often leave pages in the wrong language. That can slow sales abroad.' }],
    ['consequence_link', d => { d.variants.A.followups[0].paragraphs[1].text = 'Sales teams can wait a long time for pages in the local language. Growth often slows while they wait.' }],
    ['consequence_link', d => { d.variants.B.followups[0].paragraphs[1].text = 'Buyers often noticed the errors and trusted the site less than before.' }],
    // Note 4, second half ("lean on growth and scaling"): the consequence is the brief's.
    // A consequence about nothing in particular, in Email 1 and in a follow-up.
    ['consequence_from_brief', d => { d.variants.A.email1.pain.text = '{peer_group} often tell us buyers abroad leave the site. As a result, it can be hard to plan.' }],
    ['consequence_from_brief', d => { d.variants.A.followups[0].paragraphs[1].text = 'So it can be hard to plan. When that happens, things often get worse.' }],
    // A brief whose consequence has two parts: both wordings say the first and neither the second.
    ['consequence_from_brief', d => { d.brief.pain_angles.find(a => a.id === 'PA1')!.consequence = 'Sales abroad can stall, and new markets can cost more to enter.' }],
    // Note 5: the offer is one sentence, what we do and then what the reader gets.
    ['offer_shape', d => { d.variants.A.email1.offer.text = 'Buyers abroad can read your site. We translate your pages for {for_whom}.'; d.variants.A.email1.offer.slot_free = 'Buyers abroad can read your site. We translate your pages.' }],
    ['offer_shape', d => { d.variants.A.email1.offer.alt!.text = 'We put your pages into the language {for_whom} read.'; d.variants.A.email1.offer.alt!.slot_free = 'We put your pages into the language your buyers read.' }],
    ['offer_shape', d => { d.variants.B.email1.offer.slot_free = 'We turn your key pages into the words your buyers use, and we check each one.' }],
    ['offer_shape', d => { setPlain(d.variants.B.followups[1].paragraphs[1], 'We translate and check every page.') }],
    ['offer_shape', d => { d.variants.A.followups[1].paragraphs[1].slot_free = 'Your buyers abroad can read what you sell, because we translate the pages.' }],
    // Note 2: Emails 2 and 3 name the reader's firm, and the slot has its own rules.
    ['followup_company_missing', d => { setPlain(d.variants.A.followups[1].paragraphs[1], 'We translate the pages your sales team sends most, so buyers abroad can read what you sell.') }],
    ['followup_company_missing', d => { setPlain(d.variants.A.followups[0].paragraphs[2], 'Does that match what you see?') }],
    ['slot_free_missing', d => { d.variants.A.followups[1].paragraphs[1].slot_free = null }],
    ['followup_slot_mix', d => { d.variants.A.followups[1].paragraphs[1].text = 'We translate the pages {company} sends most, so {for_whom} abroad can read them.'; d.variants.A.followups[1].paragraphs[1].slots = ['company', 'for_whom'] }],
    ['company_possessive', d => { d.variants.B.followups[1].paragraphs[1].text = "We translate and check every page, so buyers abroad can stay on {company}'s site." }],
    ['company_outside_followups', d => { d.variants.A.email1.question.text = 'Is losing buyers abroad a problem for {company} right now?'; d.variants.A.email1.question.slots = ['company'] }],
    // THE SLOT-FREE FORM IS AN EMAIL TOO: it is what a prospect with no usable name is sent.
    // Each of these put the fault in slot_free only and passed until 2026-10-02.
    ['pain_number', d => { d.variants.A.followups[0].paragraphs[1].slot_free = 'So your sales team waits three weeks for every page.' }],
    ['consequence_asserted', d => { d.variants.A.followups[0].paragraphs[1].slot_free = 'So your growth slows.' }],
    ['ask_fragment', d => { d.variants.A.followups[0].paragraphs[2].slot_free = 'Sound like your firm?' }],
    // {company} is the reader: a flat statement about it is a statement about them.
    ['consequence_asserted', d => { d.variants.A.followups[0].paragraphs[1].text = 'So {company} loses buyers abroad.' }],
    // A brace that is not a known slot's, in either form, would be sent as written.
    ['slot_unknown', d => { d.variants.A.followups[1].paragraphs[1].slot_free = 'We translate the pages your team sends most, so buyers abroad can read what {company_name} sells.' }],
    ['slot_unknown', d => { d.variants.A.followups[1].paragraphs[1].text = 'We translate the pages your team sends most, so buyers abroad can read what {company} and {Company} sell.' }],
    ['slot_unknown', d => { d.variants.A.email1.question.text = 'Is losing buyers abroad a problem for { company } right now?' }],
    // In a frame the same slot is refused by the frame's own rule: {does} and nothing else.
    ['frame_slot', d => { d.opener_frames[1] = 'From the {company} site, {does}.' }],
    ['slot_policy', d => { d.brief.slot_policy = { for_whom_in_offer: false, source: 'invented' }; d.variants.A.followups[0].paragraphs[2] = { text: 'Does that match what {for_whom} tell you?', slots: ['for_whom'], slot_free: 'Does that match what you see?', from: ['PA2'], kind: 'ask' } }],
    ['bare_pronoun', d => { d.variants.A.email1.offer.text = 'We make them clear for {for_whom} abroad. A native speaker checks each page.'; d.variants.A.email1.offer.slot_free = 'We make them clear for buyers abroad. A native speaker checks each page.' }],
  ]

  for (const [rule, mutate] of planted) {
    it(`fires ${rule} on a planted fault`, () => {
      expect(rulesAfter(mutate)).toContain(rule)
    })
  }

  it('the filled grade is reported against a PLAIN cell, never the cell invented to stress length', () => {
    // A peer label of long words: what the client wrote is easy, and what the reader gets
    // with that label in the pain line is not.
    const d = baseDoc()
    d.brief.peer_groups[1].label = 'international furniture manufacturers'
    const hits = run(d).filter(v => v.rule === 'reading_grade_filled')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(v => /fact email1 \[(short|broad) /.test(v.where))).toBe(true)
  })

  it('PLANTED: the neutral offer may cite the outcome that answers every lead angle, and the control says which', () => {
    // Control for the two planted cases above: O1 is in resolved_by of both lead angles.
    const d = baseDoc()
    expect(d.brief.pain_angles.filter(a => a.reach === 'most_buyers').every(a => a.resolved_by.includes('O1'))).toBe(true)
    expect(run(d).filter(v => v.rule === 'neutral_offer_outcome')).toEqual([])
    // A tagged (non-neutral) variant is free to sell the outcome for its own pain only.
    d.variants.A.email1.offer.from = ['D1', 'PR1', 'O1']
    expect(run(d).filter(v => v.rule === 'neutral_offer_outcome')).toEqual([])
  })

  it('checks the firm-fact rendering, not only the slot-free one (long fill breaks the ceiling)', () => {
    // Passes slot-free; breaks only once the long {does} and {for_whom} are filled in.
    const violations = (() => {
      const d = baseDoc()
      d.variants.A.email1.offer.text = 'We translate your pages and a native speaker checks each one, so {for_whom} and their partners abroad can read your site.'
      d.variants.A.email1.offer.slot_free = 'We translate your pages and a native speaker checks each one, so buyers abroad can read your site.'
      return run(d)
    })()
    expect(violations.some(v => v.where.startsWith('fact email1 [long') && v.rule === 'sentence_length')).toBe(true)
    expect(violations.some(v => v.where.includes('slot-free') && v.rule === 'sentence_length')).toBe(false)
  })
})

describe('forbidden phrases match whole words only', () => {
  it('does not match a phrase inside a longer word', () => {
    const d = baseDoc()
    d.brief.scope.never_claims[0].phrases = ['ads']
    setPlain(d.variants.A.followups[1].paragraphs[1], 'We check every page before it leads anywhere.')
    expect(run(d).map(v => v.rule)).not.toContain('forbidden_phrase')
  })
  it('does match the phrase as a word (control)', () => {
    const d = baseDoc()
    d.brief.scope.never_claims[0].phrases = ['ads']
    setPlain(d.variants.A.followups[1].paragraphs[1], 'We check every page and never run ads.')
    expect(run(d).map(v => v.rule)).toContain('forbidden_phrase')
  })
})

describe('a slot is not read as words the writer wrote (2026-10-02)', () => {
  it('PLANTED: a pain opening "{peer_group} are often ..." is not refused for "They are"', () => {
    const d = baseDoc()
    d.variants.A.email1.pain.text = '{peer_group} are often told that buyers abroad leave the site. As a result, sales abroad can stall.'
    expect(run(d).filter(v => v.rule === 'stiff_wording')).toEqual([])
  })
  it('the same line with a written-out pair of its own is still refused (control)', () => {
    const d = baseDoc()
    d.variants.A.email1.pain.text = '{peer_group} are not often told that buyers abroad leave the site. As a result, sales abroad can stall.'
    expect(run(d).some(v => v.rule === 'stiff_wording' && /are not/i.test(v.detail))).toBe(true)
  })
})

describe('the consequence is the brief\'s (2026-10-02)', () => {
  const angle = { outcome: 'stalled growth', symptom: 'Finding new buyers slows down.', consequence: 'Growth can stall, and it gets harder to scale.' }
  it.each([
    ['So it can be hard to plan.', true],
    ['As a result, things can get worse.', true],
    // "hard" is in every consequence that says something gets harder: it proves nothing.
    ['So it can get harder.', true],
    ['As a result, growth can stall.', false],
    ['So it can get harder to scale.', false],
    // Matched loosely: "grow" is "growth", "scaling" is "scale".
    ['Over time, the firm can grow more slowly.', false],
    ['That means scaling can be tough.', false],
  ])('PLANTED: "%s" is off the brief: %s', (consequence, off) => {
    expect(findConsequencesOffTheBrief([`Peers tell us finding new buyers slows down. ${consequence}`], angle).length > 0).toBe(off)
  })
  it('the FIRST sentence is the symptom and is not held to it (control)', () => {
    expect(findConsequencesOffTheBrief(['Peers tell us the weather is often poor.'], angle)).toEqual([])
  })
  it('PLANTED: two wordings that say only the first part leave the second unsaid', () => {
    const both = ['Peers say buyers leave. As a result, growth can stall.', 'Peers say work waits. So growth can stall.']
    expect(unsaidConsequenceParts(both, angle.consequence)).toEqual(['and it gets harder to scale'])
    // Either wording may carry it, or one may carry both.
    expect(unsaidConsequenceParts([both[0], 'Peers say work waits. So it can get harder to scale.'], angle.consequence)).toEqual([])
    expect(unsaidConsequenceParts(['Peers say buyers leave. As a result, growth can stall, and it gets harder to scale.'], angle.consequence)).toEqual([])
    // A one-part consequence asks for one thing, and no consequence asks for nothing.
    expect(unsaidConsequenceParts(both, 'Growth can stall.')).toEqual([])
    expect(unsaidConsequenceParts(both, null)).toEqual([])
  })
  it('the generator is told the same', () => {
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('THE CONSEQUENCE IS THE BRIEF\'S')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('code refuses a consequence that holds no word of its angle\'s outcome, symptom or consequence')
  })
})

describe('findThreePartList', () => {
  it.each([
    ['We find the right buyers, write to them and book first meetings.', true],
    ['We translate pages, check them, and send them back.', true],
    ['When delivery is busy, growth stalls and plans slip.', false],
    ['We translate your pages for buyers abroad.', false],
    ['Buyers leave, and sales stall.', false],
    ['From your site, you make recyclable trays and films for food brands.', false],
    // A result after the last comma is not a third item, even when the customer group in
    // it holds "and": this is the shape of every offer since 2026-10-02.
    ['We translate your pages, so wholesalers and bakeries abroad can buy.', false],
    ['We learn who fits and book first meetings, so you keep winning the right clients.', false],
    // ...and three things the sender does, before the result, still are a list. Until
    // 2026-10-02 this row expected false, under a comment that said what this one says:
    // any sentence ending on a result was let through whole.
    ['We find buyers, write to them, and book meetings, so you can grow.', true],
    ['We find buyers, write to them and book meetings, so you can grow.', true],
    ['We find buyers, write to them, follow up, and book meetings, so you can grow.', true],
    // Two things and then what the reader gets, as its own clause: not a list of three.
    ['We learn who fits, book first meetings with them, and you keep winning the right clients.', false],
    ['We translate the pages, check each one, and {company} can sell abroad.', false],
    // Control: the same shape with a third thing the SENDER does is a list.
    ['We learn who fits, book first meetings with them, and handle every reply.', true],
  ])('%s -> %s', (sentence, expected) => {
    expect(findThreePartList(sentence) !== null).toBe(expected)
  })
})

describe('findAssertedConsequences (rule 1)', () => {
  it.each([
    ['{peer_group} often tell us buyers leave. That can make sales stall.', 0],
    ['Some firms tried free tools first. Buyers often noticed the errors.', 0],
    ['Some exporters see slow growth abroad.', 0],
    // "Many", "most" and the peer slot generalise to the reader: not a report on their own.
    ['Many exporters see slow growth abroad.', 1],
    ['Most exporters lose buyers abroad.', 1],
    ['{peer_group} lose buyers abroad.', 1],
    ['{peer_group} tell us buyers leave. That makes it hard to plan ahead.', 1],
    ['Sales teams wait for pages. Growth slows while they wait.', 2],
    ['Buyers leave the site. Does that happen to you?', 1],
    // A REPORT is about other people and says so: no slot needed, so it works in a follow-up.
    ['Exporters tell us a new market takes longer than planned.', 0],
    ['Most firms tell us a new market is slow.', 0],
    ['They say sales stall when pages are hard to read.', 0],
    ['We often hear that buyers leave.', 0],
    // ...and a sentence that opens like a report but is about THE READER is not one.
    ['Many of your sales stall when buyers cannot read the pages.', 1],
    ['A few bad pages cost you the sale.', 1],
    ['Exporters tell us your pages are hard to read.', 1],
    // The possibility word must be in what is SAID, not on the reporting verb.
    ['Exporters often tell us your pages are hard to read.', 1],
    ['{peer_group} often tell us buyers leave, and your sales stall.', 1],
    ['Exporters often tell us your pages can be hard to read.', 0],
    // "can't" is not "can".
    ["Your sales can't recover.", 1],
    // "other" is not a quantifier of people.
    ['Other work stops when the big client leaves.', 1],
    // The month is not the modal.
    ['Buyers leave in May.', 1],
    ['Buyers may leave.', 0],
  ])('%s -> %i asserted', (text, expected) => {
    expect(findAssertedConsequences(text)).toHaveLength(expected)
  })
})

describe('the wording product is validated, not only wording 0', () => {
  it('catches a fault that exists only when the SECOND pain wording sits above the SECOND offer', () => {
    // Each alternate is fine beside wording 0; together they push Email 1 over the band.
    const d = baseDoc()
    d.variants.A.email1.pain.alt!.text = '{peer_group} say buyers abroad often leave pages written in the wrong language for them. Sales in other countries can then slow down a great deal.'
    const violations = run(d)
    expect(violations.some(v => /w1\d\d/.test(v.where))).toBe(true)
    expect(violations.some(v => /\bw0\d\d\b/.test(v.where))).toBe(false)
  })
})

describe('a follow-up paragraph cannot leave the pain rules by changing its label', () => {
  const ASSERTED = 'Sales teams wait a long time for pages in the local language. Growth slows while they wait.'
  it('fires as kind pain (control)', () => {
    expect(rulesAfter(d => { d.variants.A.followups[0].paragraphs[1].text = ASSERTED })).toContain('consequence_asserted')
  })
  it.each(['offer', 'close'] as const)('relabelled %s, it is rejected for the label', kind => {
    // Before 2026-10-01 this returned zero violations: the cheapest "repair" of
    // consequence_asserted was to change the kind.
    const rules = rulesAfter(d => {
      d.variants.A.followups[0].paragraphs[1].text = ASSERTED
      d.variants.A.followups[0].paragraphs[1].kind = kind
    })
    expect(rules).toContain('paragraph_structure')
  })
})

describe('the same fault in two places is reported as two', () => {
  it('names both offer wordings when both cite no usable scope item', () => {
    const d = baseDoc()
    d.variants.A.email1.offer.from = ['PR1']
    d.variants.A.email1.offer.alt!.from = ['PR1']
    const wheres = run(d).filter(v => v.rule === 'offer_scope').map(v => v.where)
    expect(wheres.sort()).toEqual(['email1.offer', 'email1.offer.alt'])
  })
  it('names every paragraph with no kind', () => {
    const d = baseDoc()
    for (const p of d.variants.A.followups[0].paragraphs) delete p.kind
    expect(run(d).filter(v => v.rule === 'paragraph_kind').map(v => v.where).sort()).toEqual(['email2.p1', 'email2.p2', 'email2.p3'])
  })
  it('still reports a wording fault once however many cells render it (control)', () => {
    const d = baseDoc()
    d.variants.A.email1.question.text = 'Is losing buyers abroad a problem — right now?'
    // One fault, rendered in every cell, frame and wording combination.
    expect(run(d).filter(v => v.rule === 'dash' && v.where.startsWith('fact email1')).length).toBe(1)
  })
})

describe('rule 2 has no universal word list (Rule Zero)', () => {
  it('lets a client whose offer IS the paperwork say so', () => {
    // A universal "manual task" pattern rejected this for every client. It is task wording
    // only for a client whose brief says it is.
    const d = baseDoc()
    setPlain(d.variants.A.followups[1].paragraphs[1], 'We take the customs paperwork off your sales team.')
    expect(run(d).map(v => v.rule)).not.toContain('forbidden_phrase')
    expect(run(d).map(v => v.rule)).not.toContain('manual_task')
  })
})

describe('findPainFormFaults', () => {
  it('passes a pain that is a report and a possibility (control)', () => {
    expect(findPainFormFaults('Exporters often tell us a new market takes longer than planned. Growth can slow.')).toEqual([])
  })
  it('reports each form fault by name', () => {
    expect(findPainFormFaults('Buyers leave within two weeks. Sales always stall.').map(f => f.rule).sort())
      .toEqual(['consequence_asserted', 'consequence_asserted', 'pain_absolute', 'pain_duration', 'pain_number'])
  })
})

describe('a subject keeps the case it was written in, in every rendering', () => {
  // A subject opening on {peer_group} read "Exporters and new markets" slot-free and
  // "software makers and new markets" filled: one line, two cases, by whether the prospect
  // had a peer label.
  const email1 = () => {
    const e1 = inventedVariants().B.email1
    e1.subject = { text: '{peer_group} and new markets', slots: ['peer_group'], slot_free: null, from: ['PA2'] }
    return e1
  }
  it('slot-free, it is lower case', () => {
    expect(renderEmail1SlotFree(email1(), 'exporters', INVENTED_SIGNOFF).subject).toBe('exporters and new markets')
  })
  it('filled, and falling back, it is lower case too', () => {
    const fact = (fills: { does: string; peer_group?: string }) => renderFactEmail1({
      email1: email1(), openerFrames: INVENTED_OPENER_FRAMES, frameIndex: 0, fills, peerGroupDefault: 'exporters', signoff: INVENTED_SIGNOFF,
    })!.subject
    expect(fact({ does: 'you run dental clinics', peer_group: 'software makers' })).toBe('software makers and new markets')
    expect(fact({ does: 'you run dental clinics' })).toBe('exporters and new markets')
  })
  it('a body line opening on the same slot is still capitalised (control)', () => {
    expect(renderEmail1SlotFree(email1(), 'exporters', INVENTED_SIGNOFF).body).toContain('\n\nExporters often tell us')
  })
})

describe('a fault in an opener frame is reported as the FRAME\'s', () => {
  // The same rules run on every rendered firm-fact email, but a fault found there is filed
  // under the variant, the repair rewrites the variant, and the frame is never touched.
  it.each([
    ['an idiom', 'Down the road, {does}.', 'idiom'],
    ['an ampersand', 'Your site & pages say {does}.', 'ampersand'],
    ['a forbidden phrase', 'Your instant site says {does}.', 'forbidden_phrase'],
    ['busy wording', 'Your busy site says {does}.', 'busy_wording'],
    // No planted case reached this check on a FRAME's own words before: the three that
    // existed were a follow-up, a pain and a subject.
    ['a word that points at nobody', 'Unlike firms elsewhere, {does}.', 'ambiguous_referent'],
  ])('%s', (_name, frame, rule) => {
    const d = baseDoc()
    d.opener_frames[1] = frame
    const hit = run(d).find(v => v.rule === rule && v.where === 'opener_frames[1]')
    expect(hit).toBeDefined()
    expect(hit!.variant).toBe('*')
  })
  it('reports the same fault in two frames as two', () => {
    const d = baseDoc()
    d.opener_frames = ['Your site & pages say {does}.', 'From your site & pages, {does}.']
    expect(run(d).filter(v => v.rule === 'ampersand' && v.where.startsWith('opener_frames')).map(v => v.where)).toEqual(['opener_frames[0]', 'opener_frames[1]'])
  })
})

describe('a variant that cannot be rendered is reported, never thrown', () => {
  it('a follow-up paragraph holding a slot and no slot_free form', () => {
    // This THREW out of the validator, and so out of the generation run after its first
    // paid answer. Since 2026-10-02 a follow-up paragraph may hold {for_whom} or {company};
    // what cannot be rendered is one that holds either with no slot_free form.
    const d = baseDoc()
    d.variants.A.followups[1].paragraphs[1] = { text: 'We translate pages for {for_whom}.', slots: ['for_whom'], slot_free: null, from: ['D1'], kind: 'offer' }
    expect(() => run(d)).not.toThrow()
    expect(run(d).map(v => v.rule)).toContain('slot_free_missing')
  })
  it('a follow-up paragraph holding a slot it may not hold', () => {
    const d = baseDoc()
    d.variants.A.followups[0].paragraphs[0] = { text: '{peer_group} often tell us a new market is slow.', slots: ['peer_group'], slot_free: null, from: ['PA2'], kind: 'pain' }
    expect(() => run(d)).not.toThrow()
    expect(run(d).map(v => v.rule)).toContain('followup_slot')
  })
})

describe('findAskFragments (second reading, note 10)', () => {
  it.each([
    ['Worth a short call?', 1],
    ['Open to a quick call to see if this fits?', 1],
    ['Buyers leaving?', 1],
    ['Would a short call make sense?', 0],
    ['Is that something you see at your firm?', 0],
    ['Does that match what you see?', 0],
    ['How do buyers abroad find your pages?', 0],
    ['We translate your pages.', 0],
    // FULL SENTENCES the first pattern refused: an auxiliary with its negative, "whose",
    // and a sentence with a short lead-in before its verb.
    ["Isn't that a problem for you?", 0],
    ["Don't buyers abroad leave your site?", 0],
    ["Doesn't that match what you see?", 0],
    ["Wouldn't a short call help?", 0],
    ['Whose job is it to fix this?', 0],
    ['At your firm, is that a problem?', 0],
    ["Won't a short call help?", 0],
    ["Shan't we talk?", 0],
    ['Right now, at your firm, is that a problem?', 0],
    // FRAGMENTS the first pattern passed: a question word with no verb after it.
    ['How about a short call?', 1],
    ['What about a quick call next week?', 1],
    ['Why not a short call?', 1],
    ['For your firm, how about a short call?', 1],
    // A fragment with a tag on the end is still a fragment: the lead-in has to BE one.
    ['Worth a short call, do you think?', 1],
    ['Open to a quick call, is that fair?', 1],
    ['Honestly, what next?', 1],
    // The generator is told these three openers are out, verb or no verb.
    ['How about we talk for ten minutes next week?', 1],
  ])('%s -> %i fragments', (text, expected) => {
    expect(findAskFragments(text)).toHaveLength(expected)
  })
})

describe('findAmbiguousReferents', () => {
  it.each([
    ['Good work can go to someone else.', ['someone else']],
    ['No one else sees the pages.', ['No one else']],
    ['Sales can go to others.', ['others']],
    ['Sales can go to other people.', ['other people']],
    ['Some firms translate in house. Others use free tools.', ['Others']],
    ['Work can go to someone.', ['someone']],
    ['Buyers look elsewhere.', ['elsewhere']],
  ])('PLANTED: "%s"', (text, expected) => {
    expect(findAmbiguousReferents(text)).toEqual(expected)
  })
  it.each([
    'Others in your field often tell us the same.',
    'Others on your sales team may see the same.',
    'Others from your field tell us the same.',
    'Others of your size often say so.',
    'Others across your market say so.',
    'Others at firms like yours say so.',
    'Others like you say so.',
    'Others who export say so.',
    'Others with a site abroad say so.',
    'Others among your peers say so.',
    'Other people in your field often tell us the same.',
    'Other firms often tell us the same.',
    'Someone on your sales team can check each page.',
    'Buyers abroad can read the pages.',
  ])('"%s" says who is meant (control)', text => {
    expect(findAmbiguousReferents(text)).toEqual([])
  })
})

describe('the fourth reading (2026-10-02): what the new rules pass, and what they refuse', () => {
  it('PLANTED: a neutral frame that drops its "I" passes; the rule is about judging, not about the subject', () => {
    const d = baseDoc()
    d.opener_frames = ['Can see {does}.', 'Your site says {does}.']
    expect(run(d)).toEqual([])
  })

  it.each([
    [['Exporters often tell us buyers abroad leave the site.', 'As a result, sales abroad can stall.'], 0],
    [['Exporters often tell us buyers abroad leave the site. So sales abroad can stall, and it can be hard to grow.'], 0],
    [['Some firms tried free tools first.', 'Then buyers often noticed the errors.'], 0],
    [['Buyers often leave a page. When that happens, sales can slow.'], 0],
    // One sentence holds the symptom and what follows from it: nothing to link.
    [['Buyers often leave a page they cannot read, so sales can slow.'], 0],
    [['Exporters often tell us buyers abroad leave the site. Sales abroad can stall.'], 1],
    [['Exporters often tell us buyers abroad leave the site. That can slow sales abroad.'], 1],
    [['Exporters often tell us buyers abroad leave the site. It can be hard to grow.'], 1],
    [['Some firms tried free tools first.', 'Buyers often noticed the errors. Trust can drop.'], 2],
  ])('findUnlinkedConsequences %j -> %i', (paragraphs, expected) => {
    expect(findUnlinkedConsequences(paragraphs)).toHaveLength(expected)
  })

  it.each([
    'We learn who fits and book first meetings, so you keep winning the right clients.',
    'We translate your pages and a native speaker checks each one, so {for_whom} abroad can read your site.',
    'We run outreach up to the first meeting, so {company} can grow at a steady pace.',
    'We translate your key pages, and buyers abroad can read them.',
    'We check every page so that buyers abroad stay on your site.',
    'We check every page, which means buyers abroad stay on your site.',
  ])('offerShapeFaults: "%s" has the shape (control)', line => {
    expect(offerShapeFaults(line)).toEqual([])
  })
  it.each([
    ['two sentences', 'You can win buyers abroad. We translate your pages.'],
    ['the outcome first', 'Buyers abroad can read your site, because we translate your pages.'],
    ['no outcome at all', 'We translate your pages for buyers abroad.'],
    ['a second thing the sender does in place of the outcome', 'We translate your pages, and we check each one.'],
    ['a result too short to be one', 'We translate your pages, so yes.'],
  ])('PLANTED: offerShapeFaults refuses %s', (_why, line) => {
    expect(offerShapeFaults(line).length).toBeGreaterThan(0)
  })

  it('PLANTED: the offer sentence may run to the offer cap and no further, and every other sentence keeps the shorter cap', () => {
    const d = baseDoc()
    // 20 words with a one-word customer group, 24 with the five-word one: over the cap of 22.
    d.variants.A.email1.offer.text = 'We translate your pages and a native speaker checks each one, so {for_whom} and their partners abroad can read your site.'
    const violations = run(d).filter(v => v.rule === 'sentence_length')
    expect(OFFER_MAX_SENTENCE_WORDS).toBe(22)
    expect(violations.some(v => v.where.startsWith('fact email1 [long'))).toBe(true)
    expect(violations.some(v => v.where.startsWith('fact email1 [short') || v.where.includes('slot-free'))).toBe(false)
    // A PAIN sentence of 17 words is still over: the longer cap is the offer's alone.
    const pain = baseDoc()
    pain.variants.A.followups[0].paragraphs[0].text = 'Exporters often tell us a new market takes a great deal longer to grow than they had planned.'
    expect(run(pain).map(v => v.rule)).toContain('sentence_length')
  })

  it('PLANTED: a follow-up is validated with a real name in it, and a fault only the longest name brings is reported there', () => {
    const d = baseDoc()
    const offer = d.variants.A.followups[1].paragraphs[1]
    // 20 words with a one-word name, 23 with a four-word one.
    offer.text = 'We translate the pages your sales team sends most often today, so buyers abroad can read what {company} sells there.'
    offer.slot_free = 'We translate the pages your sales team sends most often today, so buyers abroad can read what you sell there.'
    const violations = run(d).filter(v => v.rule === 'sentence_length')
    expect(violations.map(v => v.where)).toEqual(['email3 [long fills]'])
  })

  it('renders a follow-up with the fills a prospect has, and slot-free without them', () => {
    const email3 = inventedVariants().A.followups[1]
    const stored = renderFollowupSlotFree(email3, 'exporters', INVENTED_SIGNOFF)
    expect(stored).toContain('so people overseas can read what you sell.')
    const named = renderFollowup(email3, { company: 'Acme' }, 'exporters', INVENTED_SIGNOFF)
    expect(named.body).toContain('so people overseas can read what Acme sells.')
    expect(named.slotted).toEqual([false, true, false])
    // With no fill it is the stored body, byte for byte: that equality is what composition
    // relies on to know the lines and the stored body are the same email.
    expect(renderFollowup(email3, {}, 'exporters', INVENTED_SIGNOFF).body).toBe(stored)
  })

  describe('the opener clause has its own grade, names masked (note 6)', () => {
    it('a natural clause in a trade\'s own long words is under the cap', () => {
      for (const opener of [
        'Can see you build fundraising capacity for nonprofit organizations.',
        'Your site says you provide cultural resource management and ecological surveys.',
        'Can see you run a dental practice.',
      ]) expect(openerClauseGrade(opener)!, opener).toBeLessThanOrEqual(OPENER_CLAUSE_MAX_GRADE)
    })
    it('PLANTED: a string of long abstract nouns is over it', () => {
      expect(openerClauseGrade('Can see you provide organisational internationalisation documentation.')!).toBeGreaterThan(OPENER_CLAUSE_MAX_GRADE)
    })
    it('PLANTED: a name does not count against the reader: capitalised words are masked', () => {
      const withNames = openerClauseGrade('Can see you install Coldharbourside Refrigeration Internationale systems.')!
      const lowerCase = openerClauseGrade('Can see you install coldharbourside refrigeration internationale systems.')!
      expect(withNames).toBeLessThan(lowerCase)
    })

    const compose = (does: string) => {
      const e1 = inventedVariants().A.email1
      const fills = { does, peer_group: 'software makers' }
      const render = (f: typeof fills) => renderFactEmail1({ email1: e1, openerFrames: INVENTED_OPENER_FRAMES, frameIndex: 0, fills: f, peerGroupDefault: 'exporters', signoff: INVENTED_SIGNOFF })!
      const real = render(fills)
      return validateFactEmail1({
        body: real.body,
        maskedBody: render({ does: 'you do this', peer_group: 'they' }).body,
        gradeBody: render({ ...fills, does: 'you do this' }).body,
        opener: real.opener,
        subject: real.subject,
        brief: inventedBrief(),
        signoff: INVENTED_SIGNOFF,
      }).map(v => v.rule)
    }
    it('PLANTED: at composition, a faithful clause of long trade words no longer sends the email to the template', () => {
      // Graded inside the whole email this clause tipped the filled grade over 5, and the
      // prospect fell to the template: four of 77 real prospects on 2026-10-01.
      expect(compose('you provide cultural resource management and ecological surveys')).toEqual([])
    })
    it('PLANTED: ...and a clause that is word salad is refused for its own grade', () => {
      expect(compose('you provide organisational internationalisation documentation')).toEqual(['opener_clause_grade'])
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE FIFTH READING (2026-10-02): what is read ACROSS sentences and ACROSS emails, the
// "Could" ask, and the peer rung as it will be sent.
//
// The two finders have their own tests in src/lib/style/__tests__/repetition.test.ts. What
// is proved HERE is the wiring: that the validator runs them on the emails a reader is
// actually sent (every wording, both forms of a paragraph that names the firm, the subject
// and all four bodies), and reports them in the place a repair can act on.
//
// Imported here, beside the tests that use them, so everything above this line stands
// exactly as it was.

import { FRAME_NAMES_THE_SITE, GRADE_MASK, findCouldOfAThing } from '../validate-templates'
import { INVENTED_PEER_FRAMES, inventedPeerBrief } from './fixtures/invented-client'
import { validateOutboundBrief } from '@/lib/outbound-brief/brief'

/** The invented client with the peer rung switched in: one peer group has a kind, and one frame names no site. */
function peerDoc(): Doc {
  return { brief: inventedPeerBrief(), opener_frames: [...INVENTED_PEER_FRAMES], variants: inventedVariants() }
}

/** The violations of one rule after a mutation, on the shared document unless another is given. */
function hitsAfter(rule: string, mutate: (doc: Doc) => void, from: () => Doc = baseDoc): TemplateViolation[] {
  const doc = from()
  mutate(doc)
  return run(doc).filter(v => v.rule === rule)
}

/** The word a consecutive_word finding names: its detail opens on it, in quotes. */
const repeatedWord = (v: TemplateViolation) => v.detail.match(/^"([^"]+)"/)?.[1]

/**
 * What ONE reader of variant A is sent with no fills: the subject and the four bodies, in
 * the wording chosen. Used to prove a planted phrase really is in the sequence that often,
 * so a count the validator reports is checked against the emails and not against itself.
 */
function sequenceOfA(doc: Doc, wording: { pain?: number; offer?: number; question?: number } = {}): string {
  const lines = doc.variants.A
  const email1 = renderEmail1SlotFree(lines.email1, doc.brief.peer_group_default.label, INVENTED_SIGNOFF, wording)
  const followups = lines.followups.map(f => renderFollowupSlotFree(f, doc.brief.peer_group_default.label, INVENTED_SIGNOFF))
  return [email1.subject, email1.body, ...followups].join('\n\n')
}
const timesSaid = (text: string, phrase: string) => text.toLowerCase().split(phrase.toLowerCase()).length - 1

describe('the fifth reading: both documents pass as they stand (the controls come first)', () => {
  it('the shared document has zero violations (control)', () => {
    expect(run(baseDoc())).toEqual([])
  })
  it('the peer document has zero violations, kind, after_opener label, site-free frame and all (control)', () => {
    const d = peerDoc()
    // What makes it the peer document: without these three the tests below test nothing.
    expect(d.brief.peer_groups.filter(pg => pg.kind).map(pg => [pg.id, pg.kind])).toEqual([['PG1', 'a software company']])
    expect(d.brief.peer_group_default.after_opener).toBe('Firms like yours')
    expect(d.opener_frames.filter(frame => !FRAME_NAMES_THE_SITE.test(frame))).toEqual(['Can see {does}.'])
    expect(run(d)).toEqual([])
  })
})

describe('consecutive_word: no word in two sentences in a row, as the validator reads each email (fifth reading, note 3)', () => {
  describe('in Email 1', () => {
    it('PLANTED: a question that repeats a word of the offer above it is refused at email1, and both sentences are quoted', () => {
      const QUESTION = 'Is losing buyers from other countries a problem right now?'
      const found = hitsAfter('consecutive_word', d => { d.variants.A.email1.question.text = QUESTION })
      // One finding for each offer wording the question can sit under: a reader gets one of
      // the two, and the repair is told about both.
      expect(found.map(v => [v.variant, v.where, repeatedWord(v)])).toEqual([['A', 'email1', 'buyers'], ['A', 'email1', 'buyers']])
      expect(found[0].detail).toContain('"buyers" is said in two sentences in a row')
      expect(found[0].detail).toContain(`"We translate your pages and a native speaker checks each one, so your buyers can read your site." then "${QUESTION}"`)
      expect(found[1].detail).toContain(`"We put your pages into the language your buyers read, so your site sells abroad." then "${QUESTION}"`)
    })

    it('the FIRST and THIRD sentences may share a word: only sentences in a row count (control)', () => {
      // The fixture as it stands. The pain opens on "buyers", the consequence sits between,
      // and the offer says "buyers" again.
      const [, pain, offer] = renderEmail1SlotFree(inventedVariants().A.email1, 'exporters', INVENTED_SIGNOFF).body.split('\n\n')
      expect(pain).toBe('Exporters often tell us buyers abroad leave too soon. As a result, sales can stall.')
      expect(offer).toBe('We translate your pages and a native speaker checks each one, so your buyers can read your site.')
      expect(run(baseDoc()).filter(v => v.rule === 'consecutive_word')).toEqual([])
    })

    it('the SECOND and FOURTH sentences may share a word too (control)', () => {
      // "sales" is in the consequence and in the question, with the offer between them.
      expect(hitsAfter('consecutive_word', d => { d.variants.A.email1.question.text = 'Do sales from other countries matter right now?' })).toEqual([])
    })
  })

  describe('in a follow-up, across a paragraph break', () => {
    const HARD = 'Exporters often tell us a new market can be hard to plan.'
    const HARDER = 'So growth gets harder to plan, and the launch can cost more than it should.'

    it('PLANTED: the operator\'s own example: one paragraph ends "hard to plan." and the next opens on "harder to plan"', () => {
      const d = baseDoc()
      d.variants.A.followups[0].paragraphs[0].text = HARD
      d.variants.A.followups[0].paragraphs[1].text = HARDER
      // Two paragraphs, as the reader gets them: the break does not reset the rule.
      expect(renderFollowupSlotFree(d.variants.A.followups[0], 'exporters', INVENTED_SIGNOFF)).toContain(`${HARD}\n\n${HARDER}`)
      const found = run(d).filter(v => v.rule === 'consecutive_word')
      expect(found.map(v => [v.variant, v.where, repeatedWord(v)])).toEqual([['A', 'email2', 'harder'], ['A', 'email2', 'plan']])
      for (const v of found) expect(v.detail).toContain(`"${HARD}" then "${HARDER}"`)
    })

    it('the same first paragraph followed by one that says neither word passes (control)', () => {
      expect(hitsAfter('consecutive_word', d => {
        d.variants.A.followups[0].paragraphs[0].text = HARD
        d.variants.A.followups[0].paragraphs[1].text = 'So growth can slip, and the launch can cost more than it should.'
      })).toEqual([])
    })

    it('PLANTED: it is read in Email 4 as well: the break-up is an email like the others', () => {
      const found = hitsAfter('consecutive_word', d => { d.variants.A.followups[2].paragraphs[1].text = 'If that priority changes, reply and we can pick this up.' })
      expect(found.map(v => [v.where, repeatedWord(v)])).toEqual([['email4', 'priority']])
    })
  })

  describe('in BOTH forms of a paragraph that names the reader\'s firm', () => {
    // Email 2's ask: "Does that match what {company} sees?", and "Does that match what you
    // see?" for a prospect with no usable name. The paragraph above it says "growth".
    const ask = (d: Doc) => d.variants.A.followups[0].paragraphs[2]

    it('PLANTED: a repeat that is ONLY in the slot_free form is found: that form is what most prospects are sent', () => {
      const found = hitsAfter('consecutive_word', d => { ask(d).slot_free = 'Does that match the growth you see?' })
      expect(found.map(v => [v.where, repeatedWord(v)])).toEqual([['email2', 'growth']])
      expect(found[0].detail).toContain('then "Does that match the growth you see?"')
    })

    it('PLANTED: a repeat that is ONLY in the named form is found too, in the render with the name masked', () => {
      const found = hitsAfter('consecutive_word', d => { ask(d).text = 'Does that match the growth {company} sees?' })
      expect(found.map(v => [v.where, repeatedWord(v)])).toEqual([['email2', 'growth']])
      // The name is the mask's, never a prospect's: nothing real is rendered at generation.
      expect(found[0].detail).toContain(`then "Does that match the growth ${GRADE_MASK.company} sees?"`)
    })

    it('PLANTED: the same repeat in both forms is ONE finding, so the repair is told once', () => {
      const found = hitsAfter('consecutive_word', d => {
        ask(d).text = 'Does that match the growth {company} sees?'
        ask(d).slot_free = 'Does that match the growth you see?'
      })
      expect(found).toHaveLength(1)
      expect(found[0].where).toBe('email2')
    })

    it('neither form repeats a word as the fixture stands (control)', () => {
      const d = baseDoc()
      expect(ask(d).text).toBe('Does that match what {company} sees?')
      expect(ask(d).slot_free).toBe('Does that match what you see?')
      expect(run(d).filter(v => v.rule === 'consecutive_word')).toEqual([])
    })
  })

  describe('what does not count, through the validator', () => {
    // Email 3 opens "Some firms tried free tools first and buyers noticed the errors."
    const offer = (d: Doc) => d.variants.A.followups[1].paragraphs[1]

    it('"firm" straight after "firms" is not a repeat: it stands where a pronoun would (control)', () => {
      expect(hitsAfter('consecutive_word', d => {
        offer(d).slot_free = 'We translate the pages your team sends most, so people overseas can read what your firm sells.'
      })).toEqual([])
    })

    it('PLANTED: a word with a subject of its own, in the same two sentences, is a repeat', () => {
      const found = hitsAfter('consecutive_word', d => {
        offer(d).slot_free = 'We translate the pages your team sends most, so buyers overseas can read what you sell.'
      })
      expect(found.map(v => [v.where, repeatedWord(v)])).toEqual([['email3', 'buyers']])
    })

    // Email 2 opens "... a new market starts slower than they hoped it would."
    it('a word of three letters is not counted: "new" then "new" (control)', () => {
      expect(hitsAfter('consecutive_word', d => {
        d.variants.A.followups[0].paragraphs[1].text = 'So growth plans can slip, and a new launch can cost more than it should.'
      })).toEqual([])
    })

    it('PLANTED: a word of four letters in the same place is, in either of its forms: "slower" then "slow"', () => {
      const found = hitsAfter('consecutive_word', d => {
        d.variants.A.followups[0].paragraphs[1].text = 'So growth plans can slow, and the launch can cost more than it should.'
      })
      expect(found.map(v => [v.where, repeatedWord(v)])).toEqual([['email2', 'slow']])
    })
  })
})

describe('phrase_repeat: no phrase more than twice across the four emails one reader gets (fifth reading, note 3)', () => {
  const report = (found: TemplateViolation[]) => found.map(v => [v.variant, v.where, v.detail.match(/^"[^"]+" is said \d+ times/)?.[0]])

  it('a phrase said exactly twice passes: the fixture says "buyers abroad" in the subject and in Email 1 (control)', () => {
    const d = baseDoc()
    expect(timesSaid(sequenceOfA(d), 'buyers abroad')).toBe(2)
    expect(run(d).filter(v => v.rule === 'phrase_repeat')).toEqual([])
  })

  it('PLANTED: the third use, in EMAIL 4, fires once at "sequence" with the count', () => {
    const d = baseDoc()
    d.variants.A.followups[2].paragraphs[0].text = "No problem if buyers abroad aren't a priority right now."
    expect(timesSaid(sequenceOfA(d), 'buyers abroad')).toBe(3)
    // The phrase is named as the copy first wrote it, so the writer can find it. Until
    // 2026-10-02 it was named as it is counted ("buyer abroad"), which is in no line.
    expect(report(run(d).filter(v => v.rule === 'phrase_repeat'))).toEqual([['A', 'sequence', '"buyers abroad" is said 3 times']])
  })

  it('PLANTED: the third use, in the SUBJECT, fires once at "sequence" with the count', () => {
    // "right now" is in the Email 1 question and in the break-up. The subject makes three.
    const d = baseDoc()
    expect(timesSaid(sequenceOfA(d), 'right now')).toBe(2)
    d.variants.A.email1.subject.slot_free = 'buyers abroad right now'
    expect(timesSaid(sequenceOfA(d), 'right now')).toBe(3)
    const found = run(d).filter(v => v.rule === 'phrase_repeat')
    expect(report(found)).toEqual([['A', 'sequence', '"right now" is said 3 times']])
    // It says how many to change, because a repair call reads it.
    expect(found[0].detail).toContain('twice is the most. Say it another way in 1 of them')
  })

  it('a second use where there was one passes: twice is allowed, wherever the two are (control)', () => {
    const d = baseDoc()
    expect(timesSaid(sequenceOfA(d), 'free tools')).toBe(1)
    d.variants.A.followups[2].paragraphs[0].text = 'No problem if free tools do the job right now.'
    expect(timesSaid(sequenceOfA(d), 'free tools')).toBe(2)
    expect(run(d).filter(v => v.rule === 'phrase_repeat')).toEqual([])
  })

  describe('it counts the MOST repetitive combination of wordings a reader can be sent', () => {
    // "leave too soon" is in wording 0 of the pain and nowhere else in the fixture.
    const BREAKUP = "No problem if people who leave too soon aren't a priority right now."

    it('PLANTED: in pain wording 0, in the question\'s SECOND wording and once in a follow-up, it is counted three times', () => {
      const d = baseDoc()
      d.variants.A.email1.question.alt!.text = 'Do people from overseas leave too soon to order?'
      d.variants.A.followups[2].paragraphs[0].text = BREAKUP
      // Only the reader given pain 0 with question 1 gets it three times. Every other
      // combination holds it twice or once, and a count over wording 0 alone would pass.
      expect(timesSaid(sequenceOfA(d, { pain: 0, question: 1 }), 'leave too soon')).toBe(3)
      expect(timesSaid(sequenceOfA(d, { pain: 0, question: 0 }), 'leave too soon')).toBe(2)
      expect(timesSaid(sequenceOfA(d, { pain: 1, question: 1 }), 'leave too soon')).toBe(2)
      expect(report(run(d).filter(v => v.rule === 'phrase_repeat'))).toEqual([['A', 'sequence', '"leave too soon" is said 3 times']])
    })

    it('in BOTH wordings of the pain and once in a follow-up it is twice: no reader is sent both wordings of one line (control)', () => {
      const d = baseDoc()
      d.variants.A.email1.pain.alt!.text = '{peer_group} say buyers in new places often leave too soon. So deals can be lost.'
      d.variants.A.followups[2].paragraphs[0].text = BREAKUP
      // Three across the document, two for any one reader.
      expect(timesSaid(sequenceOfA(d, { pain: 0 }), 'leave too soon')).toBe(2)
      expect(timesSaid(sequenceOfA(d, { pain: 1 }), 'leave too soon')).toBe(2)
      expect(run(d).filter(v => v.rule === 'phrase_repeat')).toEqual([])
    })
  })

  it('PLANTED: a third use only in the subject\'s SECOND wording, or only in a NAMED form, is counted', () => {
    // Reported by this test's first version, which pinned the gap: the count read the
    // subject in wording 0 and every body in its slot-free form. A reader given the second
    // subject, or a prospect whose firm is named, could be sent a phrase three times.
    // "right now" is already in the question and in the break-up.
    const inAltSubject = baseDoc()
    inAltSubject.variants.A.email1.subject.alt!.text = 'buyers abroad right now'
    expect(run(inAltSubject).filter(v => v.rule === 'phrase_repeat').map(v => v.detail).join(' ')).toContain('"right now" is said 3 times')
    const inNamedForm = baseDoc()
    inNamedForm.variants.A.followups[0].paragraphs[2].text = 'Does that match what {company} sees right now?'
    expect(run(inNamedForm).filter(v => v.rule === 'phrase_repeat').map(v => v.detail).join(' ')).toContain('"right now" is said 3 times')
  })
})

describe('ask_could: "Could" asks a person, and of a thing the question is "Would" (fifth reading, note 6)', () => {
  const where = (found: TemplateViolation[]) => found.map(v => [v.variant, v.where])

  describe('in a follow-up ask', () => {
    const callAsk = (text: string) => hitsAfter('ask_could', d => { d.variants.A.followups[1].paragraphs[2].text = text })

    it('PLANTED: "Could a short call make sense?" is refused, at the paragraph, with the sentence quoted', () => {
      const found = callAsk('Could a short call make sense?')
      expect(where(found)).toEqual([['A', 'email3.p3']])
      expect(found[0].detail).toBe('"Could" asks a person. Of a thing, ask "Would": "Could a short call make sense?"')
    })
    it('"Would a short call make sense?" passes: the operator\'s own correction (control)', () => {
      expect(callAsk('Would a short call make sense?')).toEqual([])
    })
    it('"Could we have a short call?" passes: it asks people (control)', () => {
      expect(callAsk('Could we have a short call?')).toEqual([])
    })
    it('PLANTED: the slot_free form of an ask that names the firm is read too', () => {
      const found = hitsAfter('ask_could', d => { d.variants.A.followups[0].paragraphs[2].slot_free = 'Could that match what you see?' })
      expect(where(found)).toEqual([['A', 'email2.p3']])
    })
  })

  describe('in an Email 1 question, which never asks for a meeting', () => {
    it('PLANTED: "Could that be a problem for you right now?" is refused at the question', () => {
      const found = hitsAfter('ask_could', d => { d.variants.A.email1.question.text = 'Could that be a problem for you right now?' })
      expect(where(found)).toEqual([['A', 'email1.question']])
    })
    it('PLANTED: ...and at its second wording, named as the second', () => {
      const found = hitsAfter('ask_could', d => { d.variants.A.email1.question.alt!.text = 'Could that be a problem for you?' })
      expect(where(found)).toEqual([['A', 'email1.question.alt']])
    })
    it('"Could you use more orders from overseas?" passes, and is no meeting request either (control)', () => {
      const d = baseDoc()
      d.variants.A.email1.question.text = 'Could you use more orders from overseas?'
      const rules = run(d).map(v => v.rule)
      expect(rules).not.toContain('ask_could')
      expect(rules).not.toContain('meeting_request')
    })
  })
})

describe('findCouldOfAThing', () => {
  it.each([
    'Could a short call make sense?',
    'Could an hour on this help?',
    'Could the pages be the problem?',
    'Could this be a problem for you?',
    'Could that be a problem for you?',
    'Could it help to talk?',
    'Could one short call help?',
    'Could some help be useful?',
    'Could any of this be useful?',
    // Whatever the case it was typed in.
    'could a short call make sense?',
  ])('PLANTED: "%s" asks a thing', sentence => {
    expect(findCouldOfAThing(sentence)).toEqual([sentence])
  })

  it.each([
    // Not a question: a statement may say what a thing could do.
    'Could a short call make sense.',
    'A short call could make sense.',
    // "Could" of a person is right.
    'Could we talk?',
    'Could we have a short call?',
    'Could you spare a minute?',
    'Could your team use more orders?',
    // "any" and "some" as whole words only: these two are people.
    'Could anyone on your team spare a minute?',
    'Could someone on your team spare a minute?',
    // The correction itself.
    'Would a short call make sense?',
  ])('"%s" is not one (control)', sentence => {
    expect(findCouldOfAThing(sentence)).toEqual([])
  })

  it('PLANTED: it reads each sentence of a line, and returns only the one at fault', () => {
    expect(findCouldOfAThing('We translate your pages. Could a short call make sense?')).toEqual(['Could a short call make sense?'])
    expect(findCouldOfAThing('Could a short call make sense? Could we talk?')).toEqual(['Could a short call make sense?'])
  })

  it('PLANTED: a lead-in, the other pointing words, and "one of" are each read rightly', () => {
    // Reported by this test's first version, which pinned five misses and one wrong refusal.
    for (const thing of [
      'At your firm, could a short call make sense?',   // a lead-in, which an ask may open on
      'Could these pages be the problem?',
      'Could those pages be the problem?',
      'Could another call help?',
      'Could more orders help?',
    ]) expect(findCouldOfAThing(thing), thing).toEqual([thing])
    // "One of your team" is a person among several.
    expect(findCouldOfAThing('Could one of your team spare a minute?')).toEqual([])
    // Control: after a lead-in, a question to a person still passes.
    expect(findCouldOfAThing('At your firm, could we talk this week?')).toEqual([])
  })
})

describe('the peer rung, as the validator holds it (fifth reading, note 1: build, do not check)', () => {
  describe('frame_site_free: a clause built from the stored record is never credited to the reader\'s site', () => {
    it('PLANTED: with a kind in the brief, frames that ALL name the site are refused, as a fault of the frames', () => {
      const found = hitsAfter('frame_site_free', d => { d.opener_frames = [...INVENTED_OPENER_FRAMES] }, peerDoc)
      expect(found.map(v => [v.variant, v.where])).toEqual([['*', 'opener_frames']])
    })
    it('PLANTED: "website" and "homepage" name the site as well', () => {
      expect(hitsAfter('frame_site_free', d => { d.opener_frames = ['Your website shows {does}.', 'Your homepage says {does}.'] }, peerDoc)).toHaveLength(1)
    })
    it('one frame that names no site is enough (control)', () => {
      expect(hitsAfter('frame_site_free', d => { d.opener_frames = ['Your page says {does}.', 'Your homepage says {does}.', 'Can tell {does}.'] }, peerDoc)).toEqual([])
    })
    it('with no kind in the brief, frames that all name the site are fine: there is no peer rung to carry (control)', () => {
      const d = baseDoc()
      expect(d.brief.peer_groups.some(pg => pg.kind)).toBe(false)
      expect(d.opener_frames.every(frame => FRAME_NAMES_THE_SITE.test(frame))).toBe(true)
      expect(run(d).filter(v => v.rule === 'frame_site_free')).toEqual([])
    })
  })

  describe('peer_kind_industry: a kind no stored industry can resolve to is a line born dark', () => {
    it('PLANTED: a kind whose industry is not a canonical name is reported, and the group is named', () => {
      const found = hitsAfter('peer_kind_industry', d => { d.brief.peer_groups[0].industry = 'Software And Apps' }, peerDoc)
      expect(found.map(v => [v.variant, v.where])).toEqual([['*', 'brief.peer_groups']])
      expect(found[0].detail).toContain('PG1')
      expect(found[0].detail).toContain('"Software And Apps" is not a canonical industry name')
    })
    it('a group with NO kind may hold any industry: nothing is built from it (control)', () => {
      expect(hitsAfter('peer_kind_industry', d => { d.brief.peer_groups[1].industry = 'Chairs And Tables' }, peerDoc)).toEqual([])
    })
    it('the canonical name is matched whatever its case (control)', () => {
      expect(hitsAfter('peer_kind_industry', d => { d.brief.peer_groups[0].industry = 'software publishers' }, peerDoc)).toEqual([])
    })
  })

  describe('the peer cell: the exact Email 1 a prospect of that peer group receives', () => {
    it('PLANTED: with no after_opener label, the opener and the label under it say the same word, and it is the BRIEF that is refused', () => {
      // Until 2026-10-02 this was a consecutive_word finding under every variant, at the peer
      // cell, and the repair call was asked to fix a label it cannot change. It is one
      // finding now, at the brief. The planted tests for it are at the end of this file.
      const d = peerDoc()
      delete d.brief.peer_group_default.after_opener
      const found = run(d)
      expect(found.filter(v => v.rule === 'consecutive_word')).toEqual([])
      expect(found.map(v => [v.variant, v.where, v.rule])).toEqual([['*', 'brief.peer_groups', 'peer_opener_repeat']])
      // It says what to change, and it is the brief, not the copy.
      expect(found[0].detail).toContain('give the brief a peer_group_default.after_opener label')
    })

    it('with the after_opener label the pain line opens on that instead, and nothing is refused (control)', () => {
      const d = peerDoc()
      expect(d.brief.peer_group_default.after_opener).toBe('Firms like yours')
      expect(run(d).filter(v => v.rule === 'consecutive_word')).toEqual([])
    })

    it('PLANTED: a kind of five long words is refused in the peer cell for how the opener reads', () => {
      const d = peerDoc()
      d.brief.peer_groups[0].kind = 'an international multilingual documentation management consultancy'
      // A kind the brief's own check accepts: this is reachable, not a shape nobody could store.
      expect(validateOutboundBrief(d.brief)).toEqual([])
      const found = run(d).filter(v => v.where.startsWith('fact email1 [peer PG1 / '))
      expect(found.length).toBeGreaterThan(0)
      // What fires is the opener's own grade. The 15-word cap and the word ceiling are out
      // of reach of a six-word kind: the opener is ten words and the email well under 85.
      expect(new Set(found.map(v => v.rule))).toEqual(new Set(['opener_clause_grade']))
      expect(found[0].detail).toContain('"Can see you run an international multilingual documentation management consultancy."')
    })

    it('PLANTED: a kind long enough to pass 15 words breaks the sentence cap in the peer cell', () => {
      // Longer than the brief's check allows a kind to be. The template validator does not
      // lean on that: it counts the sentence it would send.
      const d = peerDoc()
      d.brief.peer_groups[0].kind = 'a small firm that sells booking tools to dental clinics in the north'
      expect(validateOutboundBrief(d.brief).length).toBeGreaterThan(0)
      const found = run(d).filter(v => v.where.startsWith('fact email1 [peer PG1 / ') && v.rule === 'sentence_length')
      expect(found.length).toBeGreaterThan(0)
      expect(found[0].detail).toBe('17 words: "Can see you run a small firm that sells booking tools to dental clinics in the north."')
    })

    it('the fixture\'s own kind reports nothing in any peer cell (control)', () => {
      expect(run(peerDoc()).filter(v => v.where.startsWith('fact email1 [peer'))).toEqual([])
    })
  })

  describe('the after_opener label is graded like any peer label', () => {
    const LONG = 'International furniture manufacturers'

    it('PLANTED: an after_opener label of long words fires the filled grade, in a cell that names it', () => {
      const found = hitsAfter('reading_grade_filled', d => { d.brief.peer_group_default.after_opener = LONG }, peerDoc)
      expect(found.length).toBeGreaterThan(0)
      // Every hit is this label's: the two peer groups' own labels still pass.
      expect(found.every(v => v.where.includes(` / ${LONG} / `))).toBe(true)
      // And on the plain cells, graded with the fill in, as the test far above holds for a peer label.
      expect(found.every(v => /^fact email1 \[(short|broad) \/ frame \d \/ /.test(v.where))).toBe(true)
    })

    it('the fixture\'s short label passes the same grade (control)', () => {
      expect(run(peerDoc()).filter(v => v.rule === 'reading_grade_filled')).toEqual([])
    })
  })
})

describe('the generator is told what code holds across the four emails (fifth reading)', () => {
  it('PLANTED: the prompt states both repetition rules, and the two things about them a writer could not guess', () => {
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('ACROSS THE FOUR EMAILS, which one reader gets in a row')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('NO PHRASE MORE THAN TWICE')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('NO WORD IN TWO SENTENCES IN A ROW')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('A paragraph break does not reset it')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('Small words (the, can, your, more) and "firm" do not count, and neither does a word of three letters.')
  })
  it('PLANTED: the prompt gives the "Would" ask in the sentence code refuses "Could" with', () => {
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('"Could" asks a PERSON: "Could we talk?" is right, and "Could a short call make sense?" is not. Of a thing, ask "Would": "Would a short call make sense?"')
    // The prompt's own two examples are what the code does with them.
    expect(findCouldOfAThing('Could a short call make sense?')).toHaveLength(1)
    expect(findCouldOfAThing('Could we talk?')).toEqual([])
    expect(findCouldOfAThing('Would a short call make sense?')).toEqual([])
  })
  it('PLANTED: the prompt asks for English a careful native speaker would write, and says a second reader checks it', () => {
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('EVERY LINE IS ENGLISH A CAREFUL NATIVE SPEAKER WOULD WRITE')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('"arrive steadily", never "come in steady"')
  })
})

// ─── Review of 2026-10-02 (fifth reading, pre-merge) ─────────────────────────
//
// What the repetition rules did not read, and three smaller holes. Each is planted here
// with a control, on the invented client only.

import { fillSlots, wordingsOf } from '../template-shape'

describe('the repetition rules read the firm-fact Email 1 a prospect is sent, not only the slot-free one', () => {
  const consecutive = (found: TemplateViolation[]) => found.filter(v => v.rule === 'consecutive_word').map(v => [v.variant, v.where, repeatedWord(v)])

  describe('consecutive_word: the opener frame\'s own words against the line under it', () => {
    // The fixture's pain line as it stood until this review. Both frames say "site".
    const OLD_PAIN = '{peer_group} often tell us buyers abroad leave the site. As a result, sales can stall.'

    it('PLANTED: a pain line that repeats a word of the frame above it is refused, once per frame, with both sentences quoted', () => {
      const found = hitsAfter('consecutive_word', d => { d.variants.A.email1.pain.text = OLD_PAIN })
      expect(consecutive(found)).toEqual([['A', 'fact email1', 'site'], ['A', 'fact email1', 'site']])
      // The frame is quoted as the writer wrote it, slot and all: no prospect's clause is in it.
      expect(found[0].detail).toContain('"Your site says {does}." then "Exporters often tell us buyers abroad leave the site."')
      expect(found[1].detail).toContain('"From your site, {does}." then "Exporters often tell us buyers abroad leave the site."')
      // It says which of the two the writer can change.
      expect(found[0].detail).toContain('is said by the opener frame and again by the line under it')
    })

    it('a frame that does not say the word leaves the same pain line alone (control)', () => {
      expect(hitsAfter('consecutive_word', d => {
        d.variants.A.email1.pain.text = OLD_PAIN
        d.opener_frames = ['Can see {does}.', 'Can tell {does}.']
      })).toEqual([])
    })

    it('the fixture as it stands repeats nothing under either frame (control)', () => {
      const d = baseDoc()
      expect(d.opener_frames.every(frame => /site/.test(frame))).toBe(true)
      expect(wordingsOf(d.variants.A.email1.pain).some(pain => /site/.test(pain.text))).toBe(false)
      expect(run(d).filter(v => v.rule === 'consecutive_word')).toEqual([])
    })
  })

  describe('consecutive_word: a wording that exists only with the slot filled', () => {
    // Under "As a result, sales can stall." The slot_free form says nothing about sales.
    const SLOTTED = 'We translate your pages and a native speaker checks each one, so sales to {for_whom} abroad can grow.'

    it('PLANTED: a word repeated only in the SLOTTED offer is refused at the fact email, with the line quoted as written', () => {
      const found = hitsAfter('consecutive_word', d => { d.variants.A.email1.offer.text = SLOTTED })
      expect(consecutive(found)).toEqual([['A', 'fact email1', 'sales']])
      expect(found[0].detail).toContain(`"As a result, sales can stall." then "${SLOTTED}"`)
    })

    it('the same word in the slot_free form is refused at email1, as it always was (control)', () => {
      const found = hitsAfter('consecutive_word', d => {
        d.variants.A.email1.offer.slot_free = 'We translate your pages and a native speaker checks each one, so sales to your buyers can grow.'
      })
      expect(consecutive(found)).toEqual([['A', 'email1', 'sales']])
    })

    it('PLANTED: a repeat that is in BOTH forms of a line is said once, at email1: the fact email adds nothing', () => {
      const found = hitsAfter('consecutive_word', d => {
        d.variants.A.email1.offer.text = SLOTTED
        d.variants.A.email1.offer.slot_free = 'We translate your pages and a native speaker checks each one, so sales to your buyers can grow.'
      })
      expect(consecutive(found)).toEqual([['A', 'email1', 'sales']])
    })
  })

  describe('phrase_repeat: the sequence a firm-fact prospect gets, with the customer group in it', () => {
    const phraseHits = (d: Doc) => run(d).filter(v => v.rule === 'phrase_repeat').map(v => v.detail.match(/^"[^"]+" is said \d+ times/)?.[0])
    /** The break-up's first paragraph, with the reader's customers in it and the form for a prospect with none. */
    const closeWithGroup = (d: Doc, text: string) => {
      d.variants.A.followups[2].paragraphs[0] = { text, slots: ['for_whom'], slot_free: "No problem if selling overseas isn't a priority right now.", from: ['PA1'], kind: 'close' }
    }

    it('PLANTED: a third use that is only in the SLOTTED offer is counted', () => {
      // "right now" is in the Email 1 question and in the break-up. The slot_free offer does not say it.
      const d = baseDoc()
      d.variants.A.email1.offer.text = 'We translate your pages right now, so {for_whom} abroad can read your site.'
      expect(timesSaid(sequenceOfA(d), 'right now')).toBe(2)
      expect(phraseHits(d)).toEqual(['"right now" is said 3 times'])
    })

    it('PLANTED: the same words beside the customer group three times are a phrase, named with the slot', () => {
      // Subject "{for_whom} abroad", offer "... so {for_whom} abroad can read ...", and now the break-up.
      const d = baseDoc()
      closeWithGroup(d, "No problem if selling to {for_whom} abroad isn't a priority right now.")
      expect(phraseHits(d)).toEqual(['"{for_whom} abroad" is said 3 times'])
    })

    it('the customer group on its own, named three times, is NOT a phrase: the fill itself is never counted (control)', () => {
      const d = baseDoc()
      closeWithGroup(d, "No problem if {for_whom} aren't a priority right now.")
      // Three lines of this reader's sequence name the group: the subject, the offer and the break-up.
      const slotted = [d.variants.A.email1.subject.text, d.variants.A.email1.offer.text, d.variants.A.followups[2].paragraphs[0].text]
      expect(slotted.every(text => fillSlots(text, { for_whom: 'regional grocers' }, { capitalise: false })?.includes('regional grocers'))).toBe(true)
      expect(phraseHits(d)).toEqual([])
    })

    it('the fixture as it stands says no phrase three times in either sequence (control)', () => {
      expect(phraseHits(baseDoc())).toEqual([])
    })
  })
})

describe('{peer_group} opens the Email 1 pain line and stands nowhere else (review of 2026-10-02)', () => {
  it('PLANTED: in a subject it is refused: composition puts the after-opener label there, capital and all', () => {
    const found = hitsAfter('peer_group_outside_pain', d => {
      d.variants.B.email1.subject = { text: 'new markets for {peer_group}', slots: ['peer_group'], slot_free: null, from: ['PA2'] }
    })
    expect(found.map(v => [v.variant, v.where])).toEqual([['B', 'email1.subject']])
  })
  it('PLANTED: in a question and in an offer, and in a second wording, it is refused by name', () => {
    expect(hitsAfter('peer_group_outside_pain', d => {
      d.variants.A.email1.question.alt = { text: 'Is losing orders a problem for {peer_group}?', slots: ['peer_group'], slot_free: null, from: ['PA1'] }
    }).map(v => v.where)).toEqual(['email1.question.alt'])
    expect(hitsAfter('peer_group_outside_pain', d => {
      d.variants.B.email1.offer.text = 'We turn the key pages of {peer_group} into the words {for_whom} use, so more of your site gets read.'
      d.variants.B.email1.offer.slots = ['peer_group', 'for_whom']
    }).map(v => v.where)).toEqual(['email1.offer'])
  })
  it('the pain line opens on it, and the fixture uses it nowhere else (control)', () => {
    expect(run(baseDoc()).filter(v => v.rule === 'peer_group_outside_pain')).toEqual([])
    expect(inventedVariants().A.email1.pain.text.startsWith('{peer_group}')).toBe(true)
  })
  it('the generator is told the same', () => {
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('It starts the Email 1 pain line and is used nowhere else')
  })
})

describe('findCouldOfAThing: wherever the question starts (review of 2026-10-02)', () => {
  it.each([
    'So could a short call help?',
    'Could a short call, say ten minutes, make sense?',
    'And could that be a problem for you?',
  ])('PLANTED: "%s" asks a thing', sentence => {
    expect(findCouldOfAThing(sentence)).toEqual([sentence])
  })
  it.each([
    'So could we talk this week?',
    'Could we, say on Tuesday, have a short call?',
    'If a short call suits you, could we talk?',
  ])('"%s" asks a person (control)', sentence => {
    expect(findCouldOfAThing(sentence)).toEqual([])
  })
})

describe('a fault only the brief can fix is reported AS the brief\'s, and never under a variant (review of 2026-10-02)', () => {
  const noAfterOpener = (d: Doc) => { delete d.brief.peer_group_default.after_opener }

  it('PLANTED: with no after_opener label the opener and the label under it share a word, and that is a fault of the brief', () => {
    const found = hitsAfter('peer_opener_repeat', noAfterOpener, peerDoc)
    expect(found.map(v => [v.variant, v.where])).toEqual([['*', 'brief.peer_groups']])
    expect(found[0].detail).toContain('PG1')
    expect(found[0].detail).toContain('"software"')
    expect(found[0].detail).toContain('"you run a software company"')
    expect(found[0].detail).toContain('"software makers"')
    expect(found[0].detail).toContain('peer_group_default.after_opener')
  })

  it('PLANTED: it needs no variant to be seen, so it can stop a run before anything is written', () => {
    const d = peerDoc()
    noAfterOpener(d)
    d.variants = {}
    expect(run(d).filter(v => v.where.startsWith('brief.')).map(v => v.rule)).toEqual(['peer_opener_repeat'])
  })

  it('PLANTED: the copy is not blamed for it: no variant carries a finding about the label', () => {
    const d = peerDoc()
    noAfterOpener(d)
    expect(run(d).filter(v => v.variant !== '*')).toEqual([])
  })

  it('with the after_opener label there is no fault of the brief (control)', () => {
    expect(run(peerDoc()).filter(v => v.where.startsWith('brief.'))).toEqual([])
  })

  it('PLANTED: a pain line whose OWN words repeat the kind is the copy\'s fault, at the peer cell, and says to reword the line', () => {
    const found = hitsAfter('consecutive_word', d => {
      d.variants.A.email1.pain.text = '{peer_group} often tell us their software is hard to sell abroad. As a result, sales can stall.'
    }, peerDoc)
    expect(found.map(v => [v.variant, v.where, repeatedWord(v)])).toEqual([['A', 'fact email1 [peer PG1]', 'software']])
    expect(found[0].detail).toContain('"Can see you run a software company." then "Firms like yours often tell us their software is hard to sell abroad."')
    expect(found[0].detail).toContain('reword the line')
    expect(found[0].detail).not.toContain('after_opener')
  })
})

// ─── Second fix round of 2026-10-02 ──────────────────────────────────────────
//
// A word the opener frame shares with a PEER LABEL is not the writer's line to fix, and the
// peer cell is read whole. Planted on the invented client, each beside a control.

import { FRAME_WORDS } from '../validate-templates'
import { findConsecutiveRepeats } from '@/lib/style/repetition'

describe('a frame and the peer label under it share a word: the FRAME is reworded, never the line (second round, 2026-10-02)', () => {
  const consecutive = (found: TemplateViolation[]) => found.filter(v => v.rule === 'consecutive_word').map(v => [v.variant, v.where, repeatedWord(v)])
  const withDefault = (label: string, frames: string[]) => (d: Doc) => {
    d.brief.peer_group_default.label = label
    d.opener_frames = frames
  }

  it('PLANTED: "trade show exhibitors" under "Your site shows {does}." is ONE finding, at that frame, and none under a variant', () => {
    const found = hitsAfter('consecutive_word', withDefault('trade show exhibitors', ['Your site shows {does}.', 'Can see {does}.']))
    expect(consecutive(found)).toEqual([['*', 'opener_frames[0]', 'show']])
    expect(found[0].detail).toContain('"Your site shows {does}."')
    expect(found[0].detail).toContain('"trade show exhibitors"')
    // It tells the writer to change the frame, which is the writer's, and not the label.
    expect(found[0].detail).toContain('reword the frame')
  })

  it('PLANTED: "website owners" under "Your website says {does}." is the frame\'s as well', () => {
    const found = hitsAfter('consecutive_word', withDefault('website owners', ['Your website says {does}.', 'Can see {does}.']))
    expect(consecutive(found)).toEqual([['*', 'opener_frames[0]', 'website']])
  })

  it('PLANTED: the after_opener label is held to the frames too: it opens the line under a frame whenever the clause echoes the label', () => {
    const found = hitsAfter('consecutive_word', d => { d.brief.peer_group_default.after_opener = 'Firms with a site like yours' }, peerDoc)
    expect(consecutive(found)).toEqual([['*', 'opener_frames[0]', 'site']])
  })

  it('PLANTED: a peer group\'s own label is held to the frames too', () => {
    const found = hitsAfter('consecutive_word', d => {
      d.brief.peer_groups[1].label = 'website makers'
      d.opener_frames = ['Your website says {does}.', 'Can see {does}.']
    })
    expect(consecutive(found)).toEqual([['*', 'opener_frames[0]', 'website']])
  })

  it('the same label under frames that do not say the word reports nothing (control)', () => {
    expect(hitsAfter('consecutive_word', withDefault('trade show exhibitors', ['Your site says {does}.', 'Can see {does}.']))).toEqual([])
  })

  it('the WRITER\'s own word under a frame is still the writer\'s, under the variant (control)', () => {
    const found = hitsAfter('consecutive_word', d => {
      d.variants.A.email1.pain.text = '{peer_group} often tell us buyers abroad leave the site. As a result, sales can stall.'
    })
    expect(consecutive(found)).toEqual([['A', 'fact email1', 'site'], ['A', 'fact email1', 'site']])
  })
})

describe('the peer cell is read whole: the label code places, against the writer\'s next sentence (second round, 2026-10-02)', () => {
  const consecutive = (found: TemplateViolation[]) => found.filter(v => v.rule === 'consecutive_word').map(v => [v.variant, v.where, repeatedWord(v)])

  it('PLANTED: "Growing firms like yours ..." then "So growth plans can slip." is refused, under the variant, at the peer cell', () => {
    // The email a software prospect of variant B is sent: "Can see you run a software
    // company. Growing firms like yours often tell us a new market is slow to pick up. So
    // growth plans can slip." Until this round only the opener's own pair was read here, and
    // the general check fills the line with the default label, which says nothing of growth.
    const found = hitsAfter('consecutive_word', d => { d.brief.peer_group_default.after_opener = 'Growing firms like yours' }, peerDoc)
    expect(found.length).toBeGreaterThan(0)
    expect(new Set(consecutive(found).map(f => JSON.stringify(f)))).toEqual(new Set([JSON.stringify(['B', 'fact email1 [peer PG1]', 'growth'])]))
    expect(found.some(v => v.detail.includes('"Growing firms like yours often tell us a new market is slow to pick up." then "So growth plans can slip."'))).toBe(true)
    // The label is the brief's; the writer is told to reword its own sentence.
    expect(found[0].detail).toContain('the peer label')
  })

  it('the fixture\'s after_opener label, "Firms like yours", repeats nothing in the peer cell (control)', () => {
    expect(run(peerDoc()).filter(v => v.rule === 'consecutive_word')).toEqual([])
  })

  it('PLANTED: a repeat in the writer\'s own words is reported once, where it already was, and not again at the peer cell', () => {
    const found = hitsAfter('consecutive_word', d => {
      d.variants.B.email1.pain.text = '{peer_group} often tell us growth is slow to pick up. So growth plans can slip.'
    }, peerDoc)
    expect(consecutive(found)).toEqual([['B', 'email1', 'growth']])
  })
})

describe('the writer is told the frame\'s words count against the pain line under it (second round, 2026-10-02)', () => {
  it('PLANTED: the prompt names the frame words the rule counts, from the code\'s own frame list', () => {
    const counted = [...FRAME_WORDS].filter(word => findConsecutiveRepeats([word, word]).length > 0)
    // The list the code gives today. The prompt is built from FRAME_WORDS, so this pins
    // which of those words the repetition rule counts, not a second copy of the list.
    expect(counted).toEqual(['site', 'website', 'page', 'homepage', 'shows'])
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain(
      `For some prospects the pain line sits directly under an opener frame, so its first sentence uses none of the frame's words (${counted.join(', ')}), nor another form of one ("pages", "show").`)
  })
})
