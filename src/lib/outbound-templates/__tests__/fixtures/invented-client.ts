// AN INVENTED CLIENT, for the committed CI tier. The repository is public, so no real
// client's brief is committed as a fixture (Round 7, decision 2). Quillmere is invented:
// a translation service whose offer is getting its customers' pages read by buyers abroad.
// It is chosen because its offer, like some real clients' offers, genuinely involves the
// prospect's own customers, so the {for_whom} path is exercised, and because it is in an
// industry unrelated to any client (Rule Zero).
//
// The copy below satisfies every rule in validate-templates.ts, including the operator's
// rules of 2026-10-01 (consequences worded as possibilities, the question in its own
// paragraph, two wordings per Email 1 line, a proof point used once per sequence and only
// the lead differentiator in an Email 1 offer) and of 2026-10-02 (neutral opener frames,
// contractions, a consequence opened by a linking phrase, the offer as one sentence of
// process then outcome, the reader's firm named in Emails 2 and 3, no phrase more than
// twice across a sequence and no word in two sentences in a row). The control test asserts
// zero violations.
//
// THE LAST TWO HOLD FOR THE FIRM-FACT EMAIL 1 AS WELL, since 2026-10-02. Until then they were
// read on the slot-free form only, and this header claimed more than was checked: variant
// A's first pain line said "leave the site" straight under the frames below, which both say
// "site". That line now says "leave too soon".
//
// IT HOLDS NO PEER KINDS, on purpose. The peer rung needs a frame that does not name the
// site, and adding one here would move which frame every existing test prospect is given.
// Tests of that rung build their own document: see inventedPeerDocument below.

import type { OutboundBrief } from '@/lib/outbound-brief/brief'
import type { SenderSignoff, TemplateLine, VariantLines } from '../../template-shape'

export const INVENTED_SIGNOFF: SenderSignoff = { firstName: 'Sam', companyName: 'Quillmere' }

export function inventedBrief(): OutboundBrief {
  return {
    brief_version: 1,
    confirmed_by: 'test',
    confirmed_at: '2026-09-30T00:00:00Z',
    unconfirmed_items: [],
    pain_angles: [
      { id: 'PA1', rank: 1, outcome: 'lost deals', statement: 'Buyers abroad leave pages they cannot read.', symptom: 'Buyers abroad leave the site.', consequence: 'Sales abroad can stall.', reach: 'most_buyers', resolved_by: ['O3', 'O1'], source: 'invented' },
      { id: 'PA2', rank: 2, outcome: 'stalled growth', statement: 'A new market grows slower than planned while the pages wait.', symptom: 'A new market grows slower than planned.', consequence: 'Growth plans can slip.', reach: 'most_buyers', resolved_by: ['O1', 'O2'], source: 'invented' },
      { id: 'PA3', rank: 3, outcome: 'lost deals', statement: 'Free tools leave errors buyers notice.', symptom: 'Buyers notice errors in translated pages.', consequence: 'Trust can drop.', reach: 'some_buyers', resolved_by: ['O1'], source: 'invented' },
      { id: 'PA4', rank: 4, outcome: 'stalled growth', statement: 'A past translation supplier missed its dates.', symptom: 'A past supplier was late.', consequence: 'Launches can slip.', reach: 'some_buyers', conflicts_with: ['X2'], resolved_by: [], source: 'invented' },
    ],
    outcomes: [
      { id: 'O1', statement: 'Buyers abroad can read your pages and buy.', source: 'invented' },
      { id: 'O2', statement: 'A new market grows as planned.', source: 'invented' },
      // Answers the first lead angle only. It is what makes that angle's own first answer
      // NOT the outcome common to every lead angle, so the neutral offer line goes to the
      // second variant, whose first answer (O1) is.
      { id: 'O3', statement: 'Buyers abroad stay on your site.', source: 'invented' },
    ],
    competitor_categories: [
      { id: 'C1', statement: 'Translation agencies and language service providers.', phrases: ['translation agency', 'translation services', 'language service provider'], not_this: 'Software makers that sell translation tools stay in scope.', source: 'invented' },
    ],
    proof_points: [
      { id: 'PR1', rank: 1, claim: 'A native speaker checks every page.', reader_outcome: 'Buyers read pages that sound right.', evidence: 'invented', allowed_in: ['offer', 'value_note'], source: 'invented' },
      { id: 'PR2', rank: 2, claim: 'You can see the status of every page.', reader_outcome: 'You know what is live.', evidence: 'invented', allowed_in: ['value_note'], source: 'invented' },
    ],
    scope: {
      does: [
        { id: 'D1', statement: 'Translates website and sales pages into the buyer language.', source: 'invented' },
        { id: 'D2', statement: 'Shows every page and its status in one place.', proof_only: true, source: 'invented' },
      ],
      never_claims: [
        { id: 'N1', statement: 'Never claims machine translation or instant turnaround.', phrases: ['machine translation', 'instant'], source: 'invented' },
      ],
    },
    must_not_exclude: [
      { id: 'X1', statement: 'Firms with their own bilingual staff are in scope.', phrases: ['no one speaks', 'nobody speaks'], source: 'invented' },
      { id: 'X2', statement: 'Firms that never used a translation supplier are in scope.', phrases: ['your last supplier', 'your old supplier'], source: 'invented' },
    ],
    peer_groups: [
      { id: 'PG1', label: 'software makers', industry: 'Software Publishers', source: 'invented' },
      { id: 'PG2', label: 'furniture makers and importers', industry: 'Furniture Manufacturing', source: 'invented' },
    ],
    peer_group_default: { label: 'exporters', source: 'invented' },
    third_parties: [{ id: 'T1', term: 'free tools', source: 'invented' }],
    voice: [{ id: 'V1', rule: 'Plain words, short sentences.', source: 'invented' }],
    lead_differentiator: 'PR1',
    avoid_wording: [
      { id: 'W1', statement: 'Staffing is a narrow consequence for this client.', phrases: ['headcount', 'hiring'], source: 'invented' },
    ],
    slot_policy: { for_whom_in_offer: true, source: 'invented' },
    // True of every firm this client writes to: they all export. A kind made only of these
    // ("an export business") names nothing about the one prospect being written to.
    generic_kind_words: ['exporter', 'export', 'exporting'],
  }
}

export const INVENTED_OPENER_FRAMES = ['Your site says {does}.', 'From your site, {does}.']

const plain = (text: string, from: string[], kind?: TemplateLine['kind']): TemplateLine =>
  ({ text, slots: text.includes('{peer_group}') ? ['peer_group'] : [], slot_free: null, from, ...(kind ? { kind } : {}) })

/** A follow-up paragraph that names the reader's firm, with the form a prospect with no usable name receives. */
const named = (text: string, slotFree: string, from: string[], kind: TemplateLine['kind']): TemplateLine =>
  ({ text, slots: ['company'], slot_free: slotFree, from, kind })

export function inventedVariants(): Record<string, VariantLines> {
  return {
    A: {
      brief_version: 1,
      email1: {
        angle: 'PA1',
        subject: {
          text: '{for_whom} abroad', slots: ['for_whom'], slot_free: 'buyers abroad', from: ['PA1'],
          alt: { text: 'pages buyers abroad can read', slots: [], slot_free: null, from: ['PA1'] },
        },
        pain: {
          text: 'When we chat to {peer_group}, a lot of them say buyers abroad leave too soon. So sales can stall.',
          slots: ['peer_group'], slot_free: null, from: ['PA1'],
          alt: { text: "Talking to {peer_group}, we hear that buyers leave pages they can't read. So deals can be lost.", slots: ['peer_group'], slot_free: null, from: ['PA1'] },
        },
        offer: {
          text: 'We translate your pages and a native speaker checks each one, so {for_whom} abroad can read your site.',
          slots: ['for_whom'], slot_free: 'We translate your pages and a native speaker checks each one, so your buyers can read your site.', from: ['D1', 'PR1', 'O1'],
          alt: {
            text: 'We put your pages into the language {for_whom} read, so your site sells abroad.',
            slots: ['for_whom'], slot_free: 'We put your pages into the language your buyers read, so your site sells abroad.', from: ['D1', 'O1'],
          },
        },
        question: {
          text: 'Is losing orders from other countries a problem right now?', slots: [], slot_free: null, from: ['PA1'],
          alt: { text: 'Do people from overseas give up before they order?', slots: [], slot_free: null, from: ['PA1'] },
        },
        lead_in: { text: 'If {company} is seeing this too,', slots: ['company'], slot_free: "If you're seeing this too,", from: ['PA1'] },
        offer_angle: 'buyers abroad leave pages they cannot read',
      },
      followups: [
        { position: 2, angle: 'PA2', paragraphs: [
          plain('In our chats with {peer_group}, a lot of them say a new market starts slower than hoped.', ['PA2'], 'pain'),
          plain('So growth plans can slip, and the launch can cost more than it should.', ['PA2'], 'pain'),
          named('Does that match what {company} sees?', 'Does that match what you see?', ['PA2'], 'ask'),
        ] },
        { position: 3, angle: 'PA3', paragraphs: [
          plain('From what {peer_group} tell us, free tools came first and buyers noticed the errors.', ['PA3', 'T1'], 'pain'),
          named(
            'We translate the pages your team sends most, so people overseas can read what {company} sells.',
            'We translate the pages your team sends most, so people overseas can read what you sell.',
            ['D1', 'O1'], 'offer'),
          plain('Would a short call be useful?', ['D1'], 'ask'),
        ] },
        { position: 4, angle: 'PA1', paragraphs: [
          plain("No problem if selling overseas isn't a priority right now.", ['PA1'], 'close'),
          plain('If that changes, reply and we can pick this up.', ['PA1'], 'close'),
        ] },
      ],
    },
    B: {
      brief_version: 1,
      email1: {
        angle: 'PA2',
        subject: { text: 'new markets', slots: [], slot_free: null, from: ['PA2'] },
        pain: {
          text: 'When we chat to {peer_group}, many of them say a new market is slow to pick up. So growth plans can slip.',
          slots: ['peer_group'], slot_free: null, from: ['PA2'],
          alt: { text: 'Talking to {peer_group}, we hear that sales in a new country often start slower than planned. As a result, growth can stall.', slots: ['peer_group'], slot_free: null, from: ['PA2'] },
        },
        offer: {
          text: 'We turn your key pages into the words {for_whom} use, so more of your site gets read.',
          slots: ['for_whom'], slot_free: 'We turn your key pages into the words your buyers use, so more of your site gets read.', from: ['D1', 'O1'],
          alt: {
            text: 'We put your main pages into each new tongue, so {for_whom} can read your site and buy.',
            slots: ['for_whom'], slot_free: 'We put your main pages into each new tongue, so buyers can read your site and buy.', from: ['D1', 'O1'],
          },
        },
        question: {
          text: 'Is slow growth in a new country something you want to fix?', slots: [], slot_free: null, from: ['PA2'],
          alt: { text: 'Would faster sales in a new region help you?', slots: [], slot_free: null, from: ['PA2'] },
        },
        lead_in: { text: 'If {company} sees this too,', slots: ['company'], slot_free: 'If you see this too,', from: ['PA2'] },
        offer_angle: null,
      },
      followups: [
        { position: 2, angle: 'PA3', paragraphs: [
          plain('In our chats with {peer_group}, a few say they tried free tools first to save money.', ['PA3', 'T1'], 'pain'),
          plain('Then buyers often noticed the errors and trusted the pages less than before.', ['PA3'], 'pain'),
          named('Is that something {company} has seen on its own site?', 'Is that something you have seen with your own site?', ['PA3'], 'ask'),
        ] },
        { position: 3, angle: 'PA1', paragraphs: [
          plain("Buyers often leave when the words aren't in their language.", ['PA1'], 'pain'),
          named(
            'We translate and check every page, so people abroad can stay on the {company} site.',
            'We translate and check every page, so people abroad can stay on your site.',
            ['D1', 'PR1', 'O3'], 'offer'),
          plain('Would a short call be useful?', ['D1'], 'ask'),
        ] },
        { position: 4, angle: 'PA2', paragraphs: [
          plain("All good if a new region isn't the priority right now.", ['PA2'], 'close'),
          plain('If that changes, reply and we can pick this up.', ['PA2'], 'close'),
        ] },
      ],
    },
  }
}

/**
 * The same invented client with the PEER RUNG switched in: one peer group carries a kind,
 * the brief gives the label that stands under an opener, and one frame does not name the
 * site. A separate document so the shared fixture's frames, and with them the frame every
 * existing test prospect is given, stay as they were.
 */
export const INVENTED_PEER_FRAMES = ['Your site says {does}.', 'Can see {does}.']

export function inventedPeerBrief(): OutboundBrief {
  const brief = inventedBrief()
  brief.peer_groups = [
    { id: 'PG1', label: 'software makers', industry: 'Software Publishers', kind: 'a software company', source: 'invented' },
    { id: 'PG2', label: 'furniture makers and importers', industry: 'Furniture Manufacturing', source: 'invented' },
  ]
  brief.peer_group_default = { label: 'exporters', source: 'invented' }
  return brief
}
