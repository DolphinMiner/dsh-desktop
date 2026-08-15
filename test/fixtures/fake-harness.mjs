import { createServer } from 'node:http'

const mode = process.env.DSH_TEST_MODE

function stayAlive() {
  const timer = setInterval(() => undefined, 1_000)
  process.on('SIGTERM', () => {
    clearInterval(timer)
    process.exit(0)
  })
}

if (mode === 'ready') {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') process.exit(2)
    process.stdout.write(`booting\ndsh web: http://127.0.0.1:${address.port}\n`)
  })

  process.on('SIGTERM', () => server.close(() => process.exit(0)))
} else if (mode === 'unhealthy') {
  process.stdout.write('dsh web: http://127.0.0.1:9\n')
  stayAlive()
} else if (mode === 'exit') {
  setTimeout(() => process.exit(7), 20)
} else if (mode === 'silent') {
  stayAlive()
} else {
  process.stderr.write(`unknown fake Harness mode: ${String(mode)}\n`)
  process.exit(2)
}
