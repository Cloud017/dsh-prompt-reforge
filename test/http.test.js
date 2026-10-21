import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'

import { hostIsLoopback, hostnameOfHost, loopbackRequest, originIsLoopback } from '../lib/http.js'

test('hostnameOfHost drops an IPv4 port', () => {
  assert.equal(hostnameOfHost('127.0.0.1:52300'), '127.0.0.1')
})

test('hostnameOfHost keeps IPv6 brackets and drops the port', () => {
  assert.equal(hostnameOfHost('[::1]:52300'), '[::1]')
  assert.equal(hostnameOfHost('[::1]'), '[::1]')
})

test('hostIsLoopback accepts the three loopback spellings', () => {
  assert.ok(hostIsLoopback('127.0.0.1:1'))
  assert.ok(hostIsLoopback('localhost:8080'))
  assert.ok(hostIsLoopback('[::1]:9000'))
  assert.ok(hostIsLoopback('LOCALHOST'))
})

test('hostIsLoopback rejects everything else', () => {
  for (const host of ['evil.example', '10.0.0.1:80', '127.0.0.1.evil.example', '[::2]', '']) {
    assert.equal(hostIsLoopback(host), false, host)
  }
})

test('originIsLoopback treats a missing origin as same-origin', () => {
  assert.ok(originIsLoopback(undefined))
  assert.ok(originIsLoopback(''))
})

test('originIsLoopback accepts loopback origins', () => {
  assert.ok(originIsLoopback('http://127.0.0.1:52300'))
  assert.ok(originIsLoopback('http://localhost'))
})

test('originIsLoopback rejects remote and opaque origins', () => {
  assert.equal(originIsLoopback('https://evil.example'), false)
  assert.equal(originIsLoopback('null'), false)
  assert.equal(originIsLoopback('not a url'), false)
})

test('loopbackRequest requires a loopback host and a trusted origin', () => {
  assert.ok(loopbackRequest({ headers: { host: '127.0.0.1:1' } }))
  assert.ok(loopbackRequest({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' } }))
  assert.equal(loopbackRequest({ headers: { host: '127.0.0.1:1', origin: 'https://evil.example' } }), false)
  assert.equal(loopbackRequest({ headers: { host: 'evil.example' } }), false)
  assert.equal(loopbackRequest({ headers: {} }), false)
})

test('the route answers 403 to a foreign Host header', async () => {
  const { reforgeHandler } = await import('../lib/index.js')
  const server = createServer(reforgeHandler({ get: () => undefined, logger: { warn() {} } }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  // `fetch` refuses to override Host, so drive the socket directly.
  const call = (headers) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/', method: 'POST', headers },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }),
          )
        },
      )
      req.on('error', reject)
      req.end('{"draft":"hi","provider":"p","model":"m"}')
    })

  try {
    const foreign = await call({ host: 'evil.example', 'content-type': 'application/json' })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.error.code, 'request_not_trusted')

    const foreignOrigin = await call({
      host: '127.0.0.1',
      origin: 'https://evil.example',
      'content-type': 'application/json',
    })
    assert.equal(foreignOrigin.status, 403)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
