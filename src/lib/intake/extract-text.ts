// Text extraction from uploaded files.
// Called at upload time — result stored in intake_files.extracted_text.
// Agents read that column; they never download binaries at run time.
//
// pdf-parse is imported via its internal path to avoid a known Next.js issue
// where the top-level import tries to load a test file at startup.

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
] as const

export type AllowedMimeType = typeof ALLOWED_MIME_TYPES[number]

export function isAllowedMimeType(mime: string): mime is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mime)
}

export async function extractText(
  buffer: Buffer,
  mimeType: AllowedMimeType
): Promise<string> {
  switch (mimeType) {
    case 'application/pdf':
      return extractPdf(buffer)

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer)

    case 'text/plain':
    case 'text/markdown':
      return buffer.toString('utf-8')
  }
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // Import via internal path to avoid the startup test-file issue in Next.js.
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default as (
    data: Buffer,
    options?: Record<string, unknown>
  ) => Promise<{ text: string }>

  const result = await pdfParse(buffer)
  return result.text.trim()
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value.trim()
}
