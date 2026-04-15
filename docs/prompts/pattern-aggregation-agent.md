# pattern-aggregation-agent.md — System Prompt
# Stub — write the full system prompt when building this agent.
# See /prd/sections/06-agents.md for the spec: purpose, inputs, outputs, model, isolation rules.
# See CLAUDE.md — Agent conventions for stateless and isolation requirements.

## Status
[Not yet written]

## Reminders before writing
- Every prompt must enforce client_id isolation — no cross-client data references
- Agents never update strategy_documents directly — write to document_suggestions only
- Model assignment: see /prd/sections/06-agents.md for which model to use
