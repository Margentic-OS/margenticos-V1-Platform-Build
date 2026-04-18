#!/usr/bin/env node
// Wrapper that configures jiti with @/ path alias before running the agent script.
const path = require('path')
const root = path.join(__dirname, '..')
const src  = path.join(root, 'src')

const jiti = require(path.join(root, 'node_modules', 'jiti'))(null, {
  interopDefault: true,
  alias: { '@': src },
})

jiti(path.join(__dirname, 'run-messaging-agent.ts'))
