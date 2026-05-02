// Real approved strategy documents from the dev database — dumped 2026-05-01.
// Org: 74243c62-f42d-4f3f-b93e-bd5e51f0b6c0 (MargenticOS client zero).
// Do NOT replace with synthetic content — fixtures must use real documents per Group 2 spec.
// If documents are refreshed (new active version), re-dump via scripts/_dump-strategy-docs.ts.

export const ORGANISATION_ID = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'

export const TOV_DOCUMENT = JSON.stringify({
  vocabulary: {
    words_they_use: [
      'engine', 'bottleneck', 'nitty-gritty', 'thick of it', 'silky smooth',
      'dial in', 'double down', 'bridge the gap', 'quick wins', 'the math',
      'high-performing', 'robust', 'precise tuning', 'clarity', 'pipeline',
      'qualified', 'fundamentals in place', 'the path forward', 'walk you through',
      'dove into', 'deep dive', 'talk soon',
    ],
    sentence_length: 'Medium-length sentences are the default, typically 12–22 words. Doug will occasionally drop a short punchy fragment for emphasis but his natural mode is a complete thought per sentence.',
    words_they_avoid: [
      'touching base', 'circling back', 'I hope you are well', 'synergy',
      'leverage (as marketing buzzword)', 'reaching out', 'excited to announce',
      'thrilled', 'please do not hesitate', 'at your earliest convenience',
      'per my last email', 'as per', 'kind regards',
    ],
    structural_patterns: [
      'Opens by acknowledging the other person or their situation before introducing his own point',
      'Names the problem with a short, bold label, then follows with a direction — diagnosis then prescription',
      'Closes with a concrete, low-pressure next step — never an open-ended "let me know your thoughts"',
      'Uses emoji sparingly but deliberately — one or two max, as punctuation rather than decoration',
    ],
  },
  do_dont_list: {
    do: [
      'Name a specific detail about the prospect\'s situation before saying anything about yourself',
      'Use casual, energetic language — "the thick of it," "nitty-gritty," "dialled in" — to sound like a real person',
      'Close with one clear, low-pressure next step',
      'Keep first touches under 100 words — specificity forces brevity',
    ],
    dont: [
      'Never use "touching base," "circling back," "I hope you are well"',
      'Never open a message with I or We — start with the prospect\'s world',
      'Never list features or services before showing you understand the prospect\'s problem',
      'Never use more than one question per message',
    ],
  },
  voice_summary: 'Direct, casual confidence. Prospect-centric. Short messages. Specific observations. Diagnosis then action. One clear CTA.',
  writing_rules: [
    {
      rule: 'Never open with I or We',
      why: 'Centres the sender; contradicts the prospect-centric approach.',
      example_correct: 'Feast-or-famine revenue is exhausting when you know your offer actually delivers.',
      example_violation: 'I wanted to reach out because we help B2B consultants book more qualified meetings.',
    },
    {
      rule: 'One question maximum per message',
      why: 'Multiple questions dilute clarity and create friction.',
      example_correct: 'Worth a quick call to see if that lines up with where you are?',
      example_violation: 'Are you currently running outbound? Would it make sense to chat? What does your pipeline look like?',
    },
    {
      rule: 'No service-led language',
      why: 'Lead with outcomes and the problem being solved, not the mechanism.',
      example_correct: 'Qualified meetings land in your diary. A clean dashboard shows exactly what\'s driving them.',
      example_violation: 'We provide AI-driven cold email campaigns with curated messaging.',
    },
  ],
  before_after_examples: [
    {
      context: 'Cold email to a B2B consultant who relies on referrals',
      before: 'Hi Tom, I\'m Doug from MargenticOS. We help B2B consultants book qualified meetings...',
      after: 'Tom — most consultants I work with had the same problem: great offer, strong delivery, but pipeline completely dependent on referrals. Worth a quick conversation to see if it fits?',
    },
  ],
  voice_characteristics: [
    { characteristic: 'Specificity as credibility', description: 'Leads with concrete details, not abstractions. References exact numbers and named details.' },
    { characteristic: 'Observation-then-action rhythm', description: 'States what he sees, then pivots to what to do about it.' },
    { characteristic: 'Casual confidence', description: 'Relaxed language carrying serious points. Colloquial phrases even when discussing strategy.' },
    { characteristic: 'Direct address with warmth', description: 'Names the person, acknowledges what they\'ve built. Sounds like continuing a conversation.' },
    { characteristic: 'Light touch with urgency', description: 'Suggests next steps without pressuring. Gives space while keeping momentum.' },
  ],
})

export const POSITIONING_DOCUMENT = JSON.stringify({
  key_messages: {
    cold_outreach_hook: 'Your pipeline shouldn\'t reset to zero every time a referral dries up.',
    discovery_frame: 'You\'ve got a proven offer and strong delivery — the problem is that nothing is systematically putting qualified people on your calendar between referrals.',
    objection_response: 'That tracks — most of our clients had a bad agency experience before they found us. The difference is you\'ll see every email we send in a live dashboard, you\'ll own the ICP and messaging we build, and we only work with B2B consultants.',
  },
  value_themes: [
    {
      theme: 'Qualified meetings appear on my calendar every week without me writing a single cold email',
      for_whom: 'Solo consultants personally doing outbound at 9pm, exhausted by inconsistency.',
      outcome_statement: 'Predictable rhythm of qualified discovery calls, booked by the system, while they spend 100% of time on delivery.',
    },
    {
      theme: 'I can see exactly what\'s being sent under my name and know it won\'t embarrass me',
      for_whom: 'Consultants burned by a previous black-box agency. Their personal reputation IS their business.',
      outcome_statement: 'Live dashboard access to every sent email. Confidence that messaging reflects their expertise.',
    },
    {
      theme: 'I finally understand my own positioning clearly enough to articulate it',
      for_whom: 'Consultants who know they\'re good but have never had externally validated ICP and messaging.',
      outcome_statement: 'Documented, tested ICP and messaging framework they own and use across every channel.',
    },
    {
      theme: 'Completely hands-off on pipeline after onboarding',
      for_whom: 'Consultants who want to be operationally hands-off after setup. Previous agencies required constant management.',
      outcome_statement: 'After onboarding, only responsibility is showing up to qualified meetings already on their calendar.',
    },
  ],
  moore_statement: 'For solo and micro-team B2B consultants who are stuck in feast-or-famine revenue cycles because they have no consistent way to fill their pipeline, MargenticOS is a done-for-you outbound pipeline service that puts qualified meetings on their calendar every week without them lifting a finger.',
  market_category: { chosen_category: 'Done-for-you outbound pipeline service for B2B consultants' },
  unique_attributes: [
    { attribute: 'Exclusively serves founder-led B2B consulting firms — every framework built for the consulting buyer journey.' },
    { attribute: 'AI-autonomous backend that runs outbound continuously, producing messaging that reads as individually written.' },
    { attribute: 'Live client dashboard: every email sent, every reply, every meeting booked, visible in real time.' },
    { attribute: 'Clients receive transferable strategic IP — ICP, messaging, targeting, TOV — they own it regardless of whether they continue.' },
  ],
  positioning_summary: 'MargenticOS is a done-for-them cold email pipeline service built exclusively for solo and micro-team B2B consultants who have a proven offer but no predictable way to fill their calendar.',
  competitive_alternatives: [
    { name: 'Keep relying on referrals', limitation: 'Referrals are structurally uncontrollable. Revenue resets to zero every quarter when referral sources dry up.' },
    { name: 'Do outbound personally', limitation: 'Founders cannot sustain the daily cadence required. Outreach stops the moment a big project lands.' },
    { name: 'Hire a generalist agency', limitation: 'No consulting-specific context. Meetings are unqualified. Black-box operation — client never sees what\'s being sent.' },
  ],
  best_fit_characteristics: {
    must_haves: [
      'Validated B2B consulting offer with at least 3 paying clients',
      'Personally feeling the pain of unpredictable revenue right now',
      'Sells at €2K+/deal — unit economics support the retainer',
    ],
    disqualifiers: [
      'Fewer than 3 paying clients — offer not validated',
      'Average deal size below €1,000 — retainer will never be ROI-positive',
      'Wants to approve every individual email — will bottleneck execution',
    ],
  },
})

// Convenience export for use in fixtures
export const SHARED_ORG_CONTEXT = {
  tovDocument: TOV_DOCUMENT,
  positioningDocument: POSITIONING_DOCUMENT,
}
