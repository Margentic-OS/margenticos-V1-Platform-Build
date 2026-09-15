// Dollar-quote aware statement splitter. A naive split(';') breaks every plpgsql body,
// which is most of this repo's functions and all of its DO blocks.
export function splitStatements(sql) {
  const out = []
  let buf = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    // line comment
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      buf += sql.slice(i, end); i = end; continue
    }
    // block comment
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      buf += sql.slice(i, end); i = end; continue
    }
    // single-quoted string ('' escapes)
    if (c === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j++; break }
        j++
      }
      buf += sql.slice(i, j); i = j; continue
    }
    // double-quoted identifier
    if (c === '"') {
      let j = i + 1
      while (j < n && sql[j] !== '"') j++
      j++
      buf += sql.slice(i, j); i = j; continue
    }
    // dollar quote: $$ or $tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        buf += sql.slice(i, end); i = end; continue
      }
    }
    if (c === ';') { out.push(buf.trim()); buf = ''; i++; continue }
    buf += c; i++
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(s => {
    // drop statements that are only comments/whitespace
    const stripped = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    return stripped.length > 0
  })
}
