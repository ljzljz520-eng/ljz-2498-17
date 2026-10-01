// Run the API sync server and the Vite dev server together.
import { spawn } from 'node:child_process'

const env = { ...process.env, DATA_DIR: process.env.DATA_DIR || './.data' }

const api = spawn('node', ['server/http.js'], {
  env: { ...env, PORT: '3001' },
  stdio: 'inherit',
})
const web = spawn('pnpm', ['exec', 'vite', '--host', '0.0.0.0', '--port', '3000'], {
  env,
  stdio: 'inherit',
})

for (const child of [api, web]) {
  child.on('exit', (code) => {
    api.kill()
    web.kill()
    process.exit(code || 0)
  })
}
