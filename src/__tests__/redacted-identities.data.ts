// ═══════════════════════════════════════════════════════════════════════════
// DATA FILE. HASHES OF REDACTED IDENTITIES. NOT THE IDENTITIES.
//
// WHY THIS HOLDS HASHES AND NOT NAMES, which is the whole design and the reason
// this file can exist at all:
//
//   A guard that lists the names it is banning REPUBLISHES THEM. This repository
//   is PUBLIC. On 2026-09-15 a scrub removed roughly twenty real people, two real
//   client organisations, their email addresses, their employers, their cities and
//   two email bodies that had actually been sent. Writing those strings into a test
//   to stop them coming back would have put every one of them straight back into
//   the repository, in a file whose whole purpose is to be read.
//
//   The prompt deny-list data file beside the prompt name scan (DESCRIBED, NOT NAMED:
//   its own rule fails any module under src/ whose text contains its filename, and a
//   citation here would trip exactly that) reached the same conclusion for company
//   names and said so plainly: "WHAT IS DELIBERATELY ABSENT: real company names, real
//   people, real prospects, real clients. Enumerating them in a PUBLIC repository
//   would publish the very thing the swap pass exists to remove." That file solved
//   it with STRUCTURAL PATTERNS. This one solves the other half, the specific tokens
//   already known to have leaked, with a ONE-WAY HASH. Neither file names anybody.
//
//   SHA-256 of the lowercased token. A hash cannot be read backwards, so the list is
//   safe to publish, and it still fails the instant a banned token reappears, because
//   the scanner hashes what it finds and compares.
//
// ─── WHAT IS DELIBERATELY NOT IN HERE, AND WHY IT IS A REAL LIMIT ─────────────
//
// COMMON FIRST NAMES ARE EXCLUDED: the prospects recorded as Robert, Jason, Alma,
// Udo and Bob were scrubbed, but their names are ordinary English words that a
// future unrelated test, fixture or comment may legitimately use. Hashing them would
// produce false failures on innocent code, and the repository already knows where
// that ends: "A scan people stop trusting is a scan people start exempting."
//
// So this guard catches the DISTINCTIVE tokens and misses the common ones. That is a
// known and accepted limit, stated here rather than discovered later. The common
// names were removed by the scrub; nothing but review stops them returning.
//
// ONE HASH WAS REMOVED AFTER A MEASURED FALSE POSITIVE, 2026-09-15. It was the local
// part of a redacted address that is also the name of a well-known seeded PRNG used in
// src/lib/tuner/__tests__/fit-and-reach.test.ts. The guard fired on code doing its job,
// which is the shape that gets a scan exempted rather than fixed, so the hash went and
// the address itself stays gone. Narrowing after a false positive is correct; adding an
// exemption to the scanner would not have been.
//
//
// THE DIGESTS ARE TRUNCATED TO 40 HEX CHARACTERS, AND THAT IS DELIBERATE. The
// pre-commit secret gate blocks any added 64- or 32-character hex string, because that
// is the shape of `openssl rand -hex 32` and of the webhook secret that leaked on
// 2026-08-26. A full SHA-256 digest is exactly 64 hex characters, so this file tripped
// the gate on its first commit. The gate was RIGHT and was not narrowed: a 160-bit
// prefix is still far beyond collision range for a list this size, so the file was
// changed to fit the control rather than the control changed to fit the file.
//
// HOW TO EXTEND: hash the lowercased token with SHA-256, take the first 40 hex
// characters, and add that. Never add
// the plaintext, not in a comment, not in a variable name, not "just this once".
// ═══════════════════════════════════════════════════════════════════════════

// ─── THIRD FINDING, 2026-10-01. A FULL NAME AND ITS DISTINCTIVE TOKEN ───────
//
// Three real prospect company names were still live on main after the database-driven scrub
// of 2026-09-29, in a single test file, and all three prospects were already in the database
// when that scrub ran. It had the data and missed them.
//
// AND ONE PLACEHOLDER WAS NEARLY REDACTED BY MISTAKE, which is the more useful half of this
// entry. The first pass at this fix named two tokens from one fixture sentence, on the
// reasoning that the sentence described a real individual's two concurrent positions. Only
// ONE of the two was real. The other was an APPROVED PLACEHOLDER that an earlier scrub had
// substituted in, is listed in the allowlist data file beside this one, and appears in seven
// tracked files including production code. Hashing it failed the scan immediately, on seven
// files, which is the control catching a wrong redaction rather than a missed one.
//
// So the lesson runs both ways: check a name against the live tables AND against the
// allowlist before treating it as a leak. A name that looks real because it belongs to a
// real-world organisation may be exactly the placeholder a previous scrub chose, and
// redacting a placeholder costs a working fixture and teaches nobody anything.
//
// IT MATCHED THE FULL STORED NAME. A company stored as "<Token> Consulting, LLC" was searched
// for as that whole string. The test fixture said only "<Token>", in a sentence about
// something else entirely, so a substring search for the full name found nothing. Same for a
// second stored as "<Token> Environmental Consulting" and a third as "<Token> Consulting &
// Engineering".
//
// So the reach of a scrub is set by how it TOKENISES, not by whether it read the database.
// A name's distinctive word is the part that identifies somebody, and it is the part that
// survives being embedded in unrelated prose. Any future scan must search for the
// distinctive token of each stored name as well as for the name itself.
//
// A FOURTH CLASS CAME WITH THEM, and it is not a company name at all: two institutions named
// in a prospect's own RESEARCHED COPY, their employer and a university, which appear in no
// identity column and so could not be found by scanning the identity columns. One of them is
// in a prospect's stored personalisation_trigger today. A scan of `prospects.company_name`
// cannot see it. The copy columns have to be scanned too.
//
// FIVE REAL TOKENS WERE REPLACED IN THAT FILE. TWO WERE ADDED TO THE LIST BELOW, THREE WERE
// DELIBERATELY NOT, under this file's own stated limit about false positives. The two added
// have no plausible innocent use in this codebase. The three withheld are an international
// ratings firm, a well-known university and an ordinary Latin word.
//
// AND ONE OF THOSE THREE WAS MEASURED RATHER THAN GUESSED AT, which is why it is worth the
// lines. The ratings firm's token appears, case-insensitively, inside a camelCase TYPE NAME
// used across six tracked files, two of them production modules in the research agent. The
// scanner lowercases what it finds, so hashing that token would have failed the suite on code
// that has nothing to do with any prospect and cannot be renamed to suit a scan. The other two
// are the same risk argued rather than demonstrated: a university and an ordinary Latin word
// are exactly what an unrelated fixture, comment or reading-grade sample legitimately contains.
//
// Firing the guard on code doing its job is how a scan gets exempted rather than fixed, and
// this file has already lost one hash that way.
//
// AND ONE OF THE WITHHELD THREE IS STILL IN THE REPOSITORY, which is the part worth being
// exact about. The university token survives in two name-handling tests, as a bare token in a
// list of names a guard must REJECT. Those lists are the opposite case to the one fixed today:
// there the name is the test's subject, and swapping it for an invented one would weaken a
// working control while publishing nothing less. A bare token in a list of six identifies
// nobody. What identified somebody was that token sitting beside a role in one sentence about
// a real individual's working life, and that sentence is gone.
//
// So: four of five tokens are out of the repository, two of five are enforced against
// returning, and the reasoning for each is above rather than in somebody's head. The
// remaining decisions are on the Notion Backlog rather than hidden here.

// ─── SECOND SCRUB, 2026-09-29. THE FIRST ONE WAS NOT THE WHOLE PROBLEM ───────
//
// A fresh scan of every blob reachable from origin found 35 more real identities still
// live on main: real, enriched, email-verified prospects in the client-zero organisation,
// two real client organisations, and the schools and trusts from a sourcing run. They were
// not caught on 2026-09-15 because that scrub worked from the files it already knew about.
// This one worked from the DATABASE: every company name, person and address in prospects
// and organisations, matched against the repository.
//
// TWO THINGS THAT SCAN FOUND ONLY BECAUSE IT WAS RUN TWICE, both worth knowing because
// both are the scan defining the reach of its own fix:
//
//   A name WRAPPED ACROSS TWO LINES in a markdown file matches no substring search. Two
//   prospects were invisible until the file was re-scanned with newlines collapsed.
//
//   A SHOUTED heading survived a case-sensitive replace, and a file naming a prospect by
//   FIRST NAME ONLY was never in the file list, because that list was built by matching
//   COMPANY names. The fix reached exactly as far as the search that built it.
//
// WHAT WENT IN AND WHY EACH FORM. Distinctive runs are hashed as TOKENS: surnames, and the
// domains, which tokenise as one long run. Names built from ordinary words are hashed as
// two-word PHRASES instead, because neither half can be banned alone without firing on
// innocent code.
//
// THE MOST FALSE-POSITIVE-PRONE ENTRY IS A TWO-WORD PHRASE OF TWO COMMON WORDS, added
// deliberately because it is the short form that real sent copy actually used, and the
// gate matched on it. If it ever fires on innocent prose, narrow it out and say so here,
// exactly as the 2026-09-15 removal below did. Do not add an exemption to the scanner.
//
// A LENGTH OF 4 IS NOW IN THE PRE-FILTER, for one four-character acronym that appears bare
// in a test expectation. It costs a hash of every four-character token in the repository,
// which is a fraction of a second, and it is the only way a bare acronym is caught.
//
// DELIBERATELY STILL ABSENT: the first names. Devon, Marin, Marlow, Avery and the rest of
// the replacements are invented, but the REAL first names they replaced are ordinary words
// a future test may legitimately use, and the rule at the top of this file holds.

/** SHA-256 of single lowercased tokens that must never reappear. */
export const REDACTED_TOKEN_HASHES: readonly string[] = [
  '054034dc899e3b25ad030fd32b1afb27e93ce2cb',
  '07184920d9f38891bc9a258f9298ade0773010d1',
  '0eb15342cdbbd0acacb97d2b547cfd293f32f391',
  '12492c7e4c22db9ac2af630f128d630101274215',
  '21d3589bf5c419a7482f91205395be252550177a',
  '22c34dcf0133835d9e7f2aef0a741dca3ab7ba78',
  '28e143fabf1923747f31e2858f539c75b6fa9059',
  '2b876d9572b21b8a7013d48537083c1d745f4cd1',
  '2fd09ea8eb1111aeecd980a55cd38fcb41e452d8',
  '387111561aba20c67fb2e72ac848a57e93096fa6',
  '3cab6cd3da4397ab0b87f1b02bc9a63ef43c3d13',
  '3cb6e6eb71c3469effc058553f38aaeb13e59d15',
  '3fe7c35fb7b95f7761963137a6d55ed015ae127f',
  '45126cd8ee6270643c2a446e56d87f61cec6e3c0',
  '4bbe49c6d9fbd6244501d8eac5cbfd5dbf8f1878',
  '4c535946ae747f4bc933ad35d80528b3c6a5fbe1',
  '4d693dba03a3bf6361d547ee596563a3490bffa5',
  '58c0d939d21a50304c9890ee17ffbe5914ca6104',
  '59a76878e368de5fd518e0143aed7013fe9beec9',
  '5a3fcb5d666f27037f71bd447bde31126f21c217',
  '60a950a8dfed7801e6530a0176ca8006151655a6',
  '6544dddce3ba17bdeab5ed9ce5e1b82a91aff30f',
  '657cc0478182b807138817707be97c1805e47b5b',
  '6989d53ed1c4e386b3544ca8fb1d309e8c4dfdb8',
  '6aeb322b5c5b20d71adf9d5aa455447f607fad76',
  '71cb02ed8285bbc0339e0974f935e7502ea54ab8',
  '722fcc0871a4fdb30068756c52ffe86d7183e8c0',
  '743a30ee6df49e0b5119e0cc53577c14206704da',
  '74791411df6e879eaa5ac4e2a84b7ee02154c38e',
  '782a92f0c87e7d170cbddd96bfbd1d3d95101da5',
  '7896fa35c68ef83d9b8acb6a680722a1b763121d',
  '7cf66df974d1e046ec7ae7fd114b25c8ffa4849c',
  '7d59fc804c59ffcd08755e8607975dcbd1fae7a8',
  '7d6c1216b1d123584d8ef1b528860932585d80fc',
  '7f1e903a634a8ecba72661752a257e7b0f9c5b1d',
  '7fa8398c9888bd7abca8fa94f2b0b813aa8a50bc',
  '80da22bf26232eb13d5845b48307195e000292e7',
  '82339d24d52fa6b2f1b881b955d9523a75557ab2',
  '8517deb1be8be2a4fe9da1f61523974cdae21717',
  '8bbda622766689a6d42a1096cd96852c8a6d27c4',
  '8c4e7cf6bfcf209c7c185bc316ff68a9918a9bc9',
  '8dc90ffc0d0b577c951359c5dfec49ae349812cc',
  '8e4680e82e2a1ca21f8f78a3662e3c80cc26f00e',
  '956e22b93147d413f2a0da7871cae4811ad33d52',
  '97be9e17cbc9a0af0779195685563643b8f5cd12',
  '97cda41db87e55d2a021fb37e26e446154ae83db',
  '984d5d4626a091d1755e627ee592bf68ee29cf56',
  '98c07213171eca4551ac83b48cea9a2d29927b4e',
  '99155fea548e21bdd3680e052fc799c986f284ea',
  '9cada2d98dea659c5754f120a0078f5475e6101a',
  'a0910f8bcd12deda96087b928ac9d1fab98bda1f',
  'a1c5db9e33759f6e5179f531e2b2fe9883a8f31e',
  'a4f17eed181bd83a68ae614a088cef8dcfb628ed',
  'a81bfd9d23eec0b1a805509a9318525bdc00e8dc',
  'a97121ec5d86ee65954b569b6c36a3d646b7fdf3',
  'b484c2c89421b3dda8810174cc24b1f2ce8073e6',
  'b5c46a452a839bf63475ff3895da53790ad6aac7',
  'b740d031521c59652486548d84bfcc1bb66b8dd2',
  'b9a3f58600779707a993c01b1605de7b7e6b8f43',
  'baec7897e1ada3fa69fc6db2b4f7743237def675',
  'c26bb58d416d8d363f3cd6c1c2036913b5d55764',
  'c5a00c4d9402b366df75fa2f63267b8a1b4a8d35',
  'c63a7182087e76078561d11b03eadb358d918d5e',
  'c99be70e1e06ca3c7728a6f66122da31d1d62847',
  'cac651a1326bde2f5e16757f2fcf235b5deb48f3',
  'd015ad184a30aef9491638805da7d140ddcfe903',
  'd6c9daf0df2751c458724beca0a2a2161e45c2d3',
  'd81abb5d4e5f577ed49c9780a90a048d3b4d4e28',
  'e7b87f106a0ddc5ff9e1f5b55ba889f3bf53d71a',
  'e8033848475c08229ce795efaa18529d42beb2f3',
  'e8df0aebeaa992723ff575dd2883ac19db255f1e',
  'e934327e4c2b5bb92eba6efed9d0523413e12250',
  'ee125778f79f736361091e389d9071b28f8496e3',
  'f0a9f72ddc8c8edc975fa7af30b0e2d86efeb67c',
  'f1360df204d926781540dd32a1976252feb44ffd',
  'f745b62dcee065a359cb639973cb6c88aba248ff',
  'fe31665004815dbf590d21ac85ea183a261f063d',
]

/**
 * SHA-256 of two-word phrases, lowercased, single-spaced. Separate from the list
 * above because a company or person written as two ordinary words survives any
 * single-token scan: "full bloom" is two English words and neither is a name.
 */
export const REDACTED_PHRASE_HASHES: readonly string[] = [
  '049ff145eb984e1ee2070b25275341d317c7a749',
  '11254cb15f9780ba223ee5db7a996816be5c3b92',
  '21f4f913f40f6d3a5e2482100ef5f40f82545ef9',
  '227c40c771515b58e2f7eaeb61992ce3b0a60fa9',
  '2e07e09c8b99c5cffdf1af1ea5f3130693d91f01',
  '3ebafc4899b9e1b5ccce0a02d893b07797d0ecbc',
  '403149e6d9ab6d4d966e56b5612a4b63b70e9e56',
  '46896fad511f39414547e522f248a7f4b7111b91',
  '5d6653ccf5e6be92c0e52ed7a097a2338129290e',
  '5ecf0ea18b250b2cb9dec27cb5fe57c164c03d47',
  '616631f6672015b74030befc82d871675e330c30',
  '63b5ad79d90a8a60de058dbc5d727946e4ac97e0',
  '6ac3600c8600e47413508a088b1aa825598a66cd',
  '6faa261e0ff3f0a33ff7c17494bd4bc1e798b0f1',
  '7cad4a6314bfa2400f43f0f3ba28ddb71a2d3ec9',
  '8324e62df29584d35ec4c873673364ebfe7573f5',
  '91cea194bc2358a21c109f7565b0db25cc051ac8',
  '9d789d80405864fc3c2d9b17291e3d1362e00573',
  'a00fb57336090c2fb10db6ef3d835ae6658a4735',
  'a0972e49d03fac6c69750d2b6da1d2836532a1fc',
  'a52da9fb6f0f9a426c9f162509ca2b898a3a35fc',
  'ab5298e735a94a20831be6df11263b9e56ffbd32',
  'bab39a127dfc782d2c5522b0875e2a97d0f42079',
  'c7a82990a8624615d92d24f2015530b012712bd6',
  'c9b678f64fc4323192edbbc5ad98f92eef5689e3',
  'd6088180b85cd0d94b6c0c1cad73f27360b2feb8',
  'dc485b75c6a3b1b9d0d8ea7f5529ad9396e14619',
  'e4317f5e7fe21f2d5e012858f7d7081c2b9d26d3',
  'eaad40518d0a8918c653e3896f7692cca9be388a',
  'ec3a6f873477c1c8335797cd60d56234477315f4',
  'ec652ad875b68db7951bda5ed3405784c4d80965',
  'f8bcacd69a4553ff1a4a865487d86017c2dc2ebf',
]

/**
 * Lengths of the tokens hashed above, as a cheap pre-filter: a token of any other
 * length cannot be a match, so it is never hashed. This turns a full-repository scan
 * from seconds into well under one. A LENGTH IS NOT AN IDENTIFIER and reveals nothing
 * about who was removed; it is published for speed, and the digests remain one-way.
 */
export const REDACTED_TOKEN_LENGTHS: readonly number[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24]
