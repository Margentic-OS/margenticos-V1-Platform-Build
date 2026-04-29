// Text extraction from uploaded files.
// Called at upload time — result stored in intake_files.extracted_text.
// Agents read that column; they never download binaries at run time.

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
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buffer })
  const result = await parser.getText()
  return result.text.trim()
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value.trim()
}
