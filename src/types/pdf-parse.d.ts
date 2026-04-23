// Minimal type declaration for the pdf-parse internal module.
// The package ships without TypeScript types. This covers the one call site in extract-text.ts.
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(
    data: Buffer,
    options?: Record<string, unknown>
  ): Promise<{ text: string; numpages: number; info: Record<string, unknown> }>
  export default pdfParse
}
