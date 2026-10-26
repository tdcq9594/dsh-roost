// Roost 客户端自测：起一个假面板，验证 SSE 收消息 + 通用调用。
//
// 这个测试不需要 DSH，也不需要真 Roost —— 它验的是「协议对得上」：
//   · SSE 的 event/data 解析
//   · 多机器人过滤
//   · ?key= 鉴权透传
//   · /api/qq/call 的成功与失败两条路径

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { RoostClient } from '../src/roost.js'

/** 起一个假面板，返回 { url, close, calls } */
async function fakeRoost({ accessKey = '' } = {}) {
  const calls = []
  const sseClients = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const key = url.searchParams.get('key') ?? ''
    if (accessKey && key !== accessKey) {
      res.writeHead(401).end('{"error":"访问密钥无效"}')
      return
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: hello\ndata: {"bots":["main"]}\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (url.pathname === '/api/qq/call' && req.method === 'POST') {
      let s = ''
      for await (const c of req) s += c
      const body = JSON.parse(s || '{}')
      calls.push(body)
      if (body.method === 'boom') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '这个接口炸了', code: 40034100 }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: { id: 'msg-1', method: body.method } }))
      return
    }

    if (url.pathname === '/api/qq/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ api: 'sendGroup', method: 'POST', path: '/v2/groups/{id}/messages', group: '消息·群' }]))
      return
    }

    res.writeHead(404).end()
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    /** 往所有 SSE 连接推一条事件 */
    push(event, data) {
      for (const c of sseClients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    async close() {
      for (const c of sseClients) c.end()
      await new Promise((r) => server.close(r))
    },
  }
}

test('能收到 message 事件', async () => {
  const fake = await fakeRoost()
  const got = []
  const c = new RoostClient({ baseUrl: fake.url, onMessage: (m) => got.push(m) })
  c.start()
  await new Promise((r) => setTimeout(r, 120))

  fake.push('message', { chatId: 'group:g1', content: '你好', userName: '小明' })
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(got.length, 1)
  assert.equal(got[0].content, '你好')
  c.stop()
  await fake.close()
})

test('多机器人时只收指定 bot 的消息', async () => {
  const fake = await fakeRoost()
  const got = []
  const c = new RoostClient({ baseUrl: fake.url, bot: 'main', onMessage: (m) => got.push(m) })
  c.start()
  await new Promise((r) => setTimeout(r, 120))

  fake.push('message', { botId: 'other', content: '别人的' })
  fake.push('message', { botId: 'main', content: '我的' })
  await new Promise((r) => setTimeout(r, 120))

  assert.deepEqual(got.map((m) => m.content), ['我的'])
  c.stop()
  await fake.close()
})

test('?key= 鉴权生效', async () => {
  const fake = await fakeRoost({ accessKey: 'secret' })
  const errs = []
  const c = new RoostClient({ baseUrl: fake.url, accessKey: 'wrong', onError: (e) => errs.push(e) })
  c.start()
  await new Promise((r) => setTimeout(r, 150))

  assert.ok(errs.length >= 1, '密钥错了应该报错')
  assert.match(errs[0].message, /401/)
  c.stop()
  await fake.close()
})

test('call 成功返回 result', async () => {
  const fake = await fakeRoost()
  const c = new RoostClient({ baseUrl: fake.url })
  const r = await c.call('sendGroup', { content: 'hi' })
  assert.equal(r.id, 'msg-1')
  assert.equal(fake.calls[0].method, 'sendGroup')
  assert.deepEqual(fake.calls[0].args, { content: 'hi' })
  await fake.close()
})

test('call 失败时抛错并带上错误码', async () => {
  const fake = await fakeRoost()
  const c = new RoostClient({ baseUrl: fake.url })
  await assert.rejects(() => c.call('boom'), (e) => {
    assert.match(e.message, /炸了/)
    assert.equal(e.code, 40034100)
    return true
  })
  await fake.close()
})

test('capabilities 会缓存', async () => {
  const fake = await fakeRoost()
  const c = new RoostClient({ baseUrl: fake.url })
  const a = await c.capabilities()
  const b = await c.capabilities()
  assert.equal(a.length, 1)
  assert.equal(a, b, '第二次应该拿到同一个对象')
  await fake.close()
})
