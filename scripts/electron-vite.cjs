const { spawn } = require('node:child_process')
const { join } = require('node:path')

const cli = join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const args = process.argv.slice(2)
const env = { ...process.env }

delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [cli, ...args], {
  env,
  stdio: 'inherit',
  windowsHide: false
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
