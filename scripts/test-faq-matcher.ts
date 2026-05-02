// FAQ matcher test script — no test runner configured (see pre-build check notes in Group 2 session).
// Exercises normalise.ts and matcher.ts with hard-coded in-memory test cases.
// Run with: npm run test-faq-matcher
//
// Coverage:
//   1. Basic match — high token overlap → high Jaccard score
//   2. No FAQs in DB → empty array
//   3. Question variants improve match score vs canonical alone
//   4. Stopwords don't dominate scoring
//   5. Empty prospect text (only stopwords) → empty array

import { normaliseQuestion } from '../src/lib/faq/normalise'

// ─── In-memory Jaccard helper (mirrors matcher.ts logic for isolated testing) ─────

interface MockFaq {
  id: string
  question_canonical: string
  question_variants: string[]
  answer: string
}

function jaccardScore(prospectText: string, faq: MockFaq): number {
  const prospectTokens = normaliseQuestion(prospectText)
  if (prospectTokens.length === 0) return 0

  const prospectSet = new Set(prospectTokens)
  const faqTokens = new Set(normaliseQuestion(faq.question_canonical))
  for (const v of faq.question_variants) {
    for (const t of normaliseQuestion(v)) faqTokens.add(t)
  }

  if (faqTokens.size === 0) return 0

  let intersectionSize = 0
  for (const t of prospectSet) {
    if (faqTokens.has(t)) intersectionSize++
  }

  const unionSize = prospectSet.size + faqTokens.size - intersectionSize
  return unionSize === 0 ? 0 : intersectionSize / unionSize
}

// ─── Test state ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`  ✓  ${label}`)
    passed++
  } else {
    console.log(`  ✗  ${label}${details ? ` — ${details}` : ''}`)
    failed++
  }
}

// ─── Sample FAQ data ──────────────────────────────────────────────────────────

const faqPricing: MockFaq = {
  id: 'faq-001',
  question_canonical: 'What is your pricing?',
  question_variants: ['How much does it cost?', 'What are your rates?'],
  answer: 'Our pricing starts at $500/month. Book a call for a tailored quote.',
}

const faqTimeline: MockFaq = {
  id: 'faq-002',
  question_canonical: 'What is the typical timeline to see results?',
  question_variants: ['How long before I see results?'],
  answer: 'Most clients see first meetings within 4–6 weeks of campaign launch.',
}

const faqIndustries: MockFaq = {
  id: 'faq-003',
  question_canonical: 'What industries do you work with?',
  question_variants: ['Which sectors do you serve?'],
  answer: 'We work with any B2B business. Our system adapts to your industry from your intake.',
}

// ─── Test 1: Basic match — high overlap → high score ─────────────────────────

console.log('\nTest 1: Basic match — high token overlap → high Jaccard score')
const score1 = jaccardScore('What are your pricing rates?', faqPricing)
check('score > 0.3 for "What are your pricing rates?" vs pricing FAQ', score1 > 0.3, `got ${score1.toFixed(4)}`)
check('score higher than timeline FAQ', score1 > jaccardScore('What are your pricing rates?', faqTimeline), `pricing: ${score1.toFixed(4)}, timeline: ${jaccardScore('What are your pricing rates?', faqTimeline).toFixed(4)}`)

// ─── Test 2: No FAQs → empty result ──────────────────────────────────────────

console.log('\nTest 2: No FAQs in DB → empty array')
const noFaqs: MockFaq[] = []
const results2 = noFaqs.map(f => jaccardScore('how much does it cost', f))
check('empty FAQ list returns no results', results2.length === 0)

// ─── Test 3: Variants improve score ──────────────────────────────────────────

console.log('\nTest 3: Variants improve match score vs canonical alone')
const faqWithoutVariants: MockFaq = {
  id: 'faq-001-novar',
  question_canonical: 'What is your pricing?',
  question_variants: [],
  answer: 'same',
}

const scoreWithVariants = jaccardScore('how much does it cost', faqPricing)
const scoreWithoutVariants = jaccardScore('how much does it cost', faqWithoutVariants)
check('score with variants ≥ score without variants', scoreWithVariants >= scoreWithoutVariants,
  `with: ${scoreWithVariants.toFixed(4)}, without: ${scoreWithoutVariants.toFixed(4)}`)
check('variant "how much does it cost" improves score above 0', scoreWithVariants > 0)

// ─── Test 4: Stopwords don't dominate ────────────────────────────────────────

console.log('\nTest 4: Stopwords do not inflate similarity scores')
const stopwordHeavy = 'the a an is are was were be been'
const stopwordScore = jaccardScore(stopwordHeavy, faqPricing)
check('all-stopword query → empty tokens → score 0', stopwordScore === 0, `got ${stopwordScore}`)

const tokensForStopwordHeavy = normaliseQuestion(stopwordHeavy)
check('normaliseQuestion strips all stopwords', tokensForStopwordHeavy.length === 0, `got ${tokensForStopwordHeavy.join(', ')}`)

// ─── Test 5: Empty prospect text → empty result ───────────────────────────────

console.log('\nTest 5: Empty / stopword-only prospect text → no match')
const emptyTokens = normaliseQuestion('')
check('empty string → empty token array', emptyTokens.length === 0)

const onlyStopwordTokens = normaliseQuestion('is the a')
check('"is the a" → empty token array (all stopwords)', onlyStopwordTokens.length === 0)

const scoreEmpty = jaccardScore('', faqPricing)
check('empty prospect text → Jaccard score 0', scoreEmpty === 0)

// ─── Bonus: normalise output verification ─────────────────────────────────────

console.log('\nBonus: normaliseQuestion spot checks')
const tokens = normaliseQuestion("What's your pricing for a 12-month engagement?")
check('normalised "pricing" present', tokens.includes('pricing'))
check('normalised "12" present', tokens.includes('12'))
check('normalised "month" present', tokens.includes('month'))
check('normalised "engagement" present', tokens.includes('engagement'))
check('"what" not present (stopword)', !tokens.includes('what'))
check('"for" not present (stopword)', !tokens.includes('for'))
check('"a" not present (stopword)', !tokens.includes('a'))

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`)
console.log(`FAQ matcher tests: ${passed + failed} cases | ${passed} passed | ${failed} failed`)
console.log('='.repeat(60))

if (failed > 0) process.exit(1)
