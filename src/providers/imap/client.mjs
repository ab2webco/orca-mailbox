// @ts-check
// One IMAP connection over implicit TLS. Runs in the sidecar only: the plugin worker
// cannot load node:tls (README, "Where each part runs").
//
// Commands run one at a time. Every byte sent goes through encodeCommand, which runs
// the safety guard; this file has exactly one socket write.
import tls from 'node:tls'
import { createResponseReader, parseResponse } from './protocol.mjs'
import { encodeCommand } from './commands.mjs'

/** @typedef {import('./protocol.mjs').Response} Response */

export class ImapError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: string, code?: string | null, kind: 'auth' | 'protocol' | 'network' | 'timeout' }} details
   */
  constructor (message, details) {
    super(message)
    this.name = 'ImapError'
    this.status = details.status ?? null
    this.code = details.code ?? null
    this.kind = details.kind
    // Network failures and timeouts are worth another attempt; a NO is not.
    this.retry = details.kind === 'network' || details.kind === 'timeout'
  }
}

/**
 * @typedef {object} ImapConnection
 * @property {(command: string) => Promise<Response[]>} run  Untagged responses of a command.
 * @property {string[]} capabilities
 * @property {(mailbox: string | null) => void} markSelected
 * @property {(trash: string | null) => void} setTrash
 * @property {() => Promise<void>} logout
 */

/**
 * @param {{ host: string, port: number, timeoutMs: number }} options
 * @returns {Promise<ImapConnection>}
 */
export function openConnection ({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host })
    const reader = createResponseReader()
    /** @type {{ selected: string | null, trash: string | null }} */
    const state = { selected: null, trash: null }
    let seq = 0
    /** @type {{ tag: string, untagged: Response[], resolve: (r: Response[]) => void, reject: (e: Error) => void } | null} */
    let current = null
    /** @type {Promise<unknown>} */
    let queue = Promise.resolve()
    let greeted = false
    /** @type {string[]} */
    let capabilities = []

    /** @param {Error} error */
    const failAll = (error) => {
      if (!greeted) reject(error)
      if (current) current.reject(error)
      current = null
    }

    socket.setTimeout(timeoutMs, () => {
      failAll(new ImapError(`no answer from ${host} in ${timeoutMs} ms`, { kind: 'timeout' }))
      socket.destroy()
    })
    socket.on('error', (error) => failAll(new ImapError(`${host}: ${error.message}`, { kind: 'network' })))
    socket.on('close', () => failAll(new ImapError(`${host} closed the connection`, { kind: 'network' })))

    socket.on('data', (chunk) => {
      for (const bytes of reader.push(chunk)) {
        /** @type {Response} */
        let response
        try {
          response = parseResponse(bytes)
        } catch (error) {
          failAll(new ImapError(`unreadable response: ${/** @type {Error} */ (error).message}`, { kind: 'protocol' }))
          socket.destroy()
          return
        }
        if (!greeted) {
          greeted = true
          if (response.kind === 'untagged' && (response.name === 'OK' || response.name === 'PREAUTH')) {
            const caps = /^CAPABILITY (.*)$/i.exec(response.code ?? '')
            if (caps) capabilities = caps[1].toUpperCase().split(/\s+/)
            resolve(connection)
          } else {
            reject(new ImapError(`${host} refused the connection`, { kind: 'network' }))
            socket.destroy()
          }
          continue
        }
        if (!current) continue
        if (response.kind === 'tagged' && response.tag === current.tag) {
          const done = current
          current = null
          if (response.status === 'OK') done.resolve(done.untagged)
          else {
            const kind = response.code === 'AUTHENTICATIONFAILED' || response.code === 'AUTHORIZATIONFAILED'
              ? 'auth'
              : 'protocol'
            done.reject(new ImapError(response.text || response.status, { status: response.status, code: response.code, kind }))
          }
        } else {
          if (response.kind === 'capability') capabilities = response.capabilities
          current.untagged.push(response)
        }
      }
    })

    /** @type {ImapConnection} */
    const connection = {
      get capabilities () { return capabilities },
      run (command) {
        const step = queue.then(() => new Promise((resolveRun, rejectRun) => {
          seq += 1
          const tag = `M${seq}`
          current = { tag, untagged: [], resolve: resolveRun, reject: rejectRun }
          try {
            socket.write(encodeCommand(tag, command, state))
          } catch (error) {
            // Refused by the guard: nothing was written.
            current = null
            rejectRun(error)
          }
        }))
        queue = step.catch(() => {})
        return /** @type {Promise<Response[]>} */ (step)
      },
      markSelected (mailbox) { state.selected = mailbox },
      setTrash (trash) { state.trash = trash },
      async logout () {
        try {
          await connection.run('LOGOUT')
        } catch {
          // The server closes the socket after BYE; a close here is the expected end.
        }
        socket.destroy()
      }
    }
  })
}
