# intake.md — Intake Questionnaire Reference
# Stub — update as intake is built.
# Cover: questionnaire flow, file types supported, completeness logic, what to check if it breaks.
# The spec is in /prd/sections/05-intake.md.

## Intake status
[Not yet built]

## Key rules reminder
- 80% of critical fields (is_critical = true) required before document generation
- Critical open-text responses under 20 words trigger one specific follow-up
- File uploads: PDF, Word, plain text — max 10MB, max 10 files, stored in Supabase Storage
- Website ingestion: homepage + up to 3 inner pages
