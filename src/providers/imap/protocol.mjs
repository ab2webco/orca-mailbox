// @ts-check
// IMAP4rev1 / IMAP4rev2 wire format: split the byte stream into whole responses
// (literals included) and parse each one. Pure: no sockets, no clock.
//
// Literals ({n}\r\n followed by n bytes) are measured in bytes, so responses stay
// Buffers until the tokenizer has consumed them.

const CR = 0x0d
const LF = 0x0a
const SP = 0x20
const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN = 0x28
const CLOSE = 0x29
const LBRACE = 0x7b
const LBRACKET = 0x5b
const RBRACKET = 0x5d

/** @typedef {import('./token.mjs').Token} Token */

/** Streams bytes in, whole responses out. */
export function createResponseReader () {
  /** @type {Buffer} */
  let pending = Buffer.alloc(0)
  return {
    /**
     * @param {Buffer} chunk
     * @returns {Buffer[]}
     */
    push (chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      /** @type {Buffer[]} */
      const responses = []
      let start = 0
      let scan = 0
      for (;;) {
        const lf = pending.indexOf(LF, scan)
        if (lf === -1) break
        const lineEnd = lf > 0 && pending[lf - 1] === CR ? lf - 1 : lf
        const literal = /\{(\d+)\+?\}$/.exec(pending.subarray(scan, lineEnd).toString('latin1'))
        if (literal) {
          const after = lf + 1 + Number(literal[1])
          if (after > pending.length) break
          scan = after
          continue
        }
        responses.push(pending.subarray(start, lineEnd))
        start = lf + 1
        scan = start
      }
      pending = pending.subarray(start)
      return responses
    }
  }
}

/** Cursor-based tokenizer over one response. */
class Tokenizer {
  /** @param {Buffer} bytes */
  constructor (bytes) {
    this.bytes = bytes
    this.pos = 0
  }

  get done () { return this.pos >= this.bytes.length }

  skipSpaces () {
    while (this.bytes[this.pos] === SP) this.pos += 1
  }

  /** @returns {string} The rest of the response as text. */
  rest () {
    this.skipSpaces()
    const text = this.bytes.subarray(this.pos).toString('utf8')
    this.pos = this.bytes.length
    return text
  }

  /** @returns {Token} */
  next () {
    this.skipSpaces()
    const c = this.bytes[this.pos]
    if (c === OPEN) return this.list()
    if (c === QUOTE) return this.quoted()
    if (c === LBRACE) return this.literal()
    const atom = this.atom()
    return atom.toUpperCase() === 'NIL' ? null : atom
  }

  /** @returns {Token[]} */
  list () {
    this.pos += 1
    /** @type {Token[]} */
    const items = []
    for (;;) {
      this.skipSpaces()
      if (this.done) throw new SyntaxError('IMAP list is not closed')
      if (this.bytes[this.pos] === CLOSE) {
        this.pos += 1
        return items
      }
      items.push(this.next())
    }
  }

  quoted () {
    this.pos += 1
    /** @type {number[]} */
    const out = []
    while (!this.done) {
      const c = this.bytes[this.pos]
      if (c === BACKSLASH) {
        out.push(this.bytes[this.pos + 1])
        this.pos += 2
        continue
      }
      this.pos += 1
      if (c === QUOTE) return Buffer.from(out).toString('utf8')
      out.push(c)
    }
    throw new SyntaxError('IMAP quoted string is not closed')
  }

  literal () {
    const close = this.bytes.indexOf(0x7d, this.pos)
    const size = Number(this.bytes.subarray(this.pos + 1, close).toString('latin1').replace('+', ''))
    let start = close + 1
    if (this.bytes[start] === CR) start += 1
    if (this.bytes[start] === LF) start += 1
    this.pos = start + size
    return this.bytes.subarray(start, start + size).toString('utf8')
  }

  /** An atom; a [section] inside it (BODY[HEADER.FIELDS (FROM)]) may hold spaces. */
  atom () {
    const begin = this.pos
    let depth = 0
    while (!this.done) {
      const c = this.bytes[this.pos]
      if (c === LBRACKET) depth += 1
      else if (c === RBRACKET) depth -= 1
      else if (depth === 0 && (c === SP || c === OPEN || c === CLOSE || c === CR || c === LF)) break
      this.pos += 1
    }
    if (this.pos === begin) {
      throw new SyntaxError(`unexpected IMAP byte 0x${(this.bytes[this.pos] ?? 0).toString(16)}`)
    }
    return this.bytes.subarray(begin, this.pos).toString('utf8')
  }
}

/**
 * @typedef {{ kind: 'continuation', text: string }
 *   | { kind: 'tagged', tag: string, status: string, code: string | null, text: string }
 *   | { kind: 'untagged', name: string, code: string | null, text: string }
 *   | { kind: 'capability', capabilities: string[] }
 *   | { kind: 'list', flags: string[], delimiter: string | null, name: string }
 *   | { kind: 'status', name: string, counters: Record<string, number> }
 *   | { kind: 'search', numbers: number[] }
 *   | { kind: 'count', name: string, value: number }
 *   | { kind: 'fetch', seq: number, attributes: Record<string, Token> }
 *   | { kind: 'other', name: string, text: string }} Response
 */

/** @param {string} text */
function splitCode (text) {
  const match = /^\[([^\]]*)\]\s?(.*)$/s.exec(text)
  return match ? { code: match[1], text: match[2] } : { code: null, text }
}

/** @param {Token} token */
function asString (token) {
  if (typeof token !== 'string') throw new SyntaxError('expected an IMAP string')
  return token
}

/** @param {Token} token @returns {Token[]} */
function asList (token) {
  if (!Array.isArray(token)) throw new SyntaxError('expected an IMAP list')
  return token
}

/**
 * @param {Buffer | string} input  One whole response without its trailing CRLF.
 * @returns {Response}
 */
export function parseResponse (input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  if (bytes[0] === 0x2b) {
    return { kind: 'continuation', text: bytes.subarray(1).toString('utf8').trim() }
  }
  const t = new Tokenizer(bytes)
  const tag = t.atom()
  if (tag !== '*') {
    t.skipSpaces()
    const status = t.atom().toUpperCase()
    return { kind: 'tagged', tag, status, ...splitCode(t.rest()) }
  }
  t.skipSpaces()
  const head = t.atom()
  if (/^\d+$/.test(head)) {
    t.skipSpaces()
    const name = t.atom().toUpperCase()
    if (name === 'FETCH') {
      const items = asList(t.next())
      /** @type {Record<string, Token>} */
      const attributes = {}
      for (let i = 0; i + 1 < items.length; i += 2) {
        attributes[asString(items[i]).toUpperCase()] = items[i + 1]
      }
      return { kind: 'fetch', seq: Number(head), attributes }
    }
    return { kind: 'count', name, value: Number(head) }
  }
  const name = head.toUpperCase()
  switch (name) {
    case 'OK': case 'NO': case 'BAD': case 'BYE': case 'PREAUTH':
      return { kind: 'untagged', name, ...splitCode(t.rest()) }
    case 'CAPABILITY':
      return { kind: 'capability', capabilities: t.rest().split(/\s+/).filter(Boolean).map((c) => c.toUpperCase()) }
    case 'LIST': case 'LSUB': {
      const flags = asList(t.next()).map(asString)
      const delimiter = t.next()
      const mailbox = t.next()
      return {
        kind: 'list',
        flags,
        delimiter: delimiter === null ? null : asString(delimiter),
        name: asString(mailbox)
      }
    }
    case 'STATUS': {
      const mailbox = asString(t.next())
      const items = asList(t.next())
      /** @type {Record<string, number>} */
      const counters = {}
      for (let i = 0; i + 1 < items.length; i += 2) {
        counters[asString(items[i]).toUpperCase()] = Number(asString(items[i + 1]))
      }
      return { kind: 'status', name: mailbox, counters }
    }
    case 'SEARCH':
      return { kind: 'search', numbers: t.rest().split(/\s+/).filter(Boolean).map(Number) }
    default:
      return { kind: 'other', name, text: t.rest() }
  }
}

/**
 * An IMAP quoted string. CR and LF cannot be quoted; mailbox names and credentials
 * never contain them, so they are refused rather than sent as a literal.
 * @param {string} value
 */
export function quoteString (value) {
  if (/[\r\n]/.test(value)) throw new RangeError('IMAP quoted string cannot hold CR or LF (line breaks)')
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}
