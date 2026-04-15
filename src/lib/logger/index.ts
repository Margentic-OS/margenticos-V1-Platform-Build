// Single logging abstraction — all log output goes through here.
// Never use console.log, console.error, or console.warn directly in application code.
// See CLAUDE.md — Code quality section.

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const isDevelopment = process.env.NODE_ENV === 'development'

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  // Debug logs are suppressed in production
  if (level === 'debug' && !isDevelopment) return

  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(meta ?? {}),
  }

  // In production, structured JSON output for log aggregation
  if (!isDevelopment) {
    process.stdout.write(JSON.stringify(entry) + '\n')
    return
  }

  // In development, readable format
  const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`
  if (level === 'error') {
    process.stderr.write(`${prefix} ${message} ${meta ? JSON.stringify(meta) : ''}\n`)
  } else {
    process.stdout.write(`${prefix} ${message} ${meta ? JSON.stringify(meta) : ''}\n`)
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info:  (message: string, meta?: Record<string, unknown>) => log('info',  message, meta),
  warn:  (message: string, meta?: Record<string, unknown>) => log('warn',  message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
}
