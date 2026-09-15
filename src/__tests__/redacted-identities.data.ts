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

/** SHA-256 of single lowercased tokens that must never reappear. */
export const REDACTED_TOKEN_HASHES: readonly string[] = [
  '12492c7e4c22db9ac2af630f128d630101274215',
  '22c34dcf0133835d9e7f2aef0a741dca3ab7ba78',
  '28e143fabf1923747f31e2858f539c75b6fa9059',
  '2b876d9572b21b8a7013d48537083c1d745f4cd1',
  '2fd09ea8eb1111aeecd980a55cd38fcb41e452d8',
  '3cab6cd3da4397ab0b87f1b02bc9a63ef43c3d13',
  '3cb6e6eb71c3469effc058553f38aaeb13e59d15',
  '45126cd8ee6270643c2a446e56d87f61cec6e3c0',
  '4c535946ae747f4bc933ad35d80528b3c6a5fbe1',
  '054034dc899e3b25ad030fd32b1afb27e93ce2cb',
  '59a76878e368de5fd518e0143aed7013fe9beec9',
  '5a3fcb5d666f27037f71bd447bde31126f21c217',
  '7896fa35c68ef83d9b8acb6a680722a1b763121d',
  '7d59fc804c59ffcd08755e8607975dcbd1fae7a8',
  '7d6c1216b1d123584d8ef1b528860932585d80fc',
  '82339d24d52fa6b2f1b881b955d9523a75557ab2',
  '8c4e7cf6bfcf209c7c185bc316ff68a9918a9bc9',
  '8dc90ffc0d0b577c951359c5dfec49ae349812cc',
  '98c07213171eca4551ac83b48cea9a2d29927b4e',
  '99155fea548e21bdd3680e052fc799c986f284ea',
  '9cada2d98dea659c5754f120a0078f5475e6101a',
  'a0910f8bcd12deda96087b928ac9d1fab98bda1f',
  'a97121ec5d86ee65954b569b6c36a3d646b7fdf3',
  'b484c2c89421b3dda8810174cc24b1f2ce8073e6',
  'b740d031521c59652486548d84bfcc1bb66b8dd2',
  'b9a3f58600779707a993c01b1605de7b7e6b8f43',
  'baec7897e1ada3fa69fc6db2b4f7743237def675',
  'd015ad184a30aef9491638805da7d140ddcfe903',
  'd6c9daf0df2751c458724beca0a2a2161e45c2d3',
  'd81abb5d4e5f577ed49c9780a90a048d3b4d4e28',
  'e8033848475c08229ce795efaa18529d42beb2f3',
  'e8df0aebeaa992723ff575dd2883ac19db255f1e',
  'e934327e4c2b5bb92eba6efed9d0523413e12250',
  'f1360df204d926781540dd32a1976252feb44ffd',
  'f745b62dcee065a359cb639973cb6c88aba248ff',
]

/**
 * SHA-256 of two-word phrases, lowercased, single-spaced. Separate from the list
 * above because a company or person written as two ordinary words survives any
 * single-token scan: "full bloom" is two English words and neither is a name.
 */
export const REDACTED_PHRASE_HASHES: readonly string[] = [
  '11254cb15f9780ba223ee5db7a996816be5c3b92',
  '227c40c771515b58e2f7eaeb61992ce3b0a60fa9',
  '403149e6d9ab6d4d966e56b5612a4b63b70e9e56',
  '46896fad511f39414547e522f248a7f4b7111b91',
  '6faa261e0ff3f0a33ff7c17494bd4bc1e798b0f1',
  'a00fb57336090c2fb10db6ef3d835ae6658a4735',
  'a0972e49d03fac6c69750d2b6da1d2836532a1fc',
  'e4317f5e7fe21f2d5e012858f7d7081c2b9d26d3',
  'eaad40518d0a8918c653e3896f7692cca9be388a',
  'f8bcacd69a4553ff1a4a865487d86017c2dc2ebf',
]

/**
 * Lengths of the tokens hashed above, as a cheap pre-filter: a token of any other
 * length cannot be a match, so it is never hashed. This turns a full-repository scan
 * from seconds into well under one. A LENGTH IS NOT AN IDENTIFIER and reveals nothing
 * about who was removed; it is published for speed, and the digests remain one-way.
 */
export const REDACTED_TOKEN_LENGTHS: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 22, 23]
