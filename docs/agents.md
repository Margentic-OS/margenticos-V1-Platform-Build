# agents.md — Agent Documentation
# Stub — update as each agent is built.
# Cover: each agent's purpose, inputs, outputs, isolation rules, entry point file, prompt file.
# The spec is in /prd/sections/06-agents.md.

## Agents built
[None yet]

## Agent isolation reminder
Every agent invocation must pass client_id as a required parameter.
Agents must be stateless — no module-level variables.
Each agent has its own entry point file in src/lib/agents/.
System prompts live in /docs/prompts/.
