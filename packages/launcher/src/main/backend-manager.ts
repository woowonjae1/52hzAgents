import { spawn, execSync, ChildProcess } from 'child_process'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { setBackendUrl } from './backend-config'

interface PidRecord {
  pid: number
  name: string
  time: number
}

export class BackendManager {
  private childProcess: ChildProcess | null = null
  private currentUrl: string = 'http://localhost:8000'

  private getRuntimeDirectory(): string {
    const isPackaged = app.isPackaged
    const workspaceRoot = isPackaged
      ? path.join(process.resourcesPath, 'workspace')
      : path.resolve(__dirname, '../../../../workspace')
    return path.join(workspaceRoot, '.dev-sqlite')
  }

  private getPidFilePath(): string {
    return path.join(this.getRuntimeDirectory(), 'backend.pid')
  }

  /**
   * Verifies if the target PID actually corresponds to a 52hzAgent backend server process.
   */
  private isMatchingBackendProcess(pid: number, expectedName: string): boolean {
    try {
      const allowedNames = new Set<string>([
        expectedName.toLowerCase().trim(),
        'server.exe',
        'server',
        'go.exe',
        'go',
      ])

      if (process.platform === 'win32') {
        const stdout = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV`, { encoding: 'utf8' }).trim()
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        for (const line of lines) {
          if (line.toLowerCase().startsWith('"image name"')) continue
          const parts = line.split('","')
          if (parts.length > 0) {
            const imageName = parts[0].replace(/^"/, '').replace(/"$/, '').trim().toLowerCase()
            if (allowedNames.has(imageName)) {
              return true
            }
          }
        }
        return false
      } else {
        // POSIX (macOS / Linux)
        let comm = ''
        try {
          if (fs.existsSync(`/proc/${pid}/comm`)) {
            comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase()
          } else {
            comm = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim().toLowerCase()
          }
        } catch {
          return false
        }
        const baseComm = path.basename(comm)
        return allowedNames.has(baseComm) || allowedNames.has(comm)
      }
    } catch {
      return false
    }
  }

  /**
   * Cleans up orphaned backend server processes from previous launcher runs.
   */
  private async cleanupOrphans(): Promise<void> {
    const pidFile = this.getPidFilePath()
    if (!fs.existsSync(pidFile)) return

    try {
      const content = fs.readFileSync(pidFile, 'utf8').trim()
      let pid = 0
      let expectedName = 'server'

      if (content.startsWith('{')) {
        const record = JSON.parse(content) as PidRecord
        pid = record.pid
        expectedName = record.name || 'server'
        if (record.time && Date.now() - record.time > 14 * 24 * 60 * 60 * 1000) {
          console.log(`[BackendManager] PID record file is older than 14 days (${new Date(record.time).toISOString()}); ignoring stale record.`)
          pid = 0
        }
      } else {
        pid = parseInt(content, 10)
      }

      if (!isNaN(pid) && pid > 0) {
        if (this.isMatchingBackendProcess(pid, expectedName)) {
          console.log(`[BackendManager] Verified orphan process PID ${pid} (${expectedName}); terminating process tree...`)
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { stdio: 'ignore' })
          } else {
            try {
              process.kill(-pid, 'SIGKILL')
            } catch {
              try { process.kill(pid, 'SIGKILL') } catch {}
            }
          }
          await new Promise((r) => setTimeout(r, 500))
        } else {
          console.log(`[BackendManager] PID ${pid} is not a verified backend process; skipping kill.`)
        }
      }
    } catch (err) {
      console.warn('[BackendManager] Failed to clean up orphan PID file:', err)
    } finally {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
      } catch {}
    }
  }

  /**
   * Probe whether a backend is responding with HTTP 200/health at the target URL.
   */
  public async probeHealth(url: string, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const healthUrl = `${url.replace(/\/$/, '')}/v1/health`
        const req = http.get(healthUrl, { timeout: timeoutMs }, (res) => {
          if (res.statusCode === 200) {
            resolve(true)
          } else {
            resolve(false)
          }
        })
        req.on('error', () => resolve(false))
        req.on('timeout', () => {
          req.destroy()
          resolve(false)
        })
      } catch {
        resolve(false)
      }
    })
  }

  /**
   * Main entrypoint: Ensure a backend is active.
   * Probes default port 8000 first (reuse mode).
   * Spawns Go server if no active backend is found.
   */
  public async ensureBackend(): Promise<string> {
    const defaultUrl = 'http://localhost:8000'
    const isAlive = await this.probeHealth(defaultUrl)

    if (isAlive) {
      this.currentUrl = defaultUrl
      setBackendUrl(defaultUrl)
      console.log(`[BackendManager] Reusing existing backend at ${defaultUrl}`)
      return defaultUrl
    }

    // Health probe failed — clean up any orphan backend processes from previous runs before spawning
    await this.cleanupOrphans()

    console.log('[BackendManager] No active backend detected. Spawning Go backend server...')
    await this.spawnBackendServer()

    // Poll until healthy (up to 30 seconds)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await this.probeHealth(defaultUrl, 1000)) {
        this.currentUrl = defaultUrl
        setBackendUrl(defaultUrl)
        console.log(`[BackendManager] Successfully spawned & verified backend at ${defaultUrl}`)
        return defaultUrl
      }
      await new Promise((r) => setTimeout(r, 1000))
    }

    console.warn(`[BackendManager] Backend spawn timeout; falling back to default ${defaultUrl}`)
    this.currentUrl = defaultUrl
    setBackendUrl(defaultUrl)
    return defaultUrl
  }

  /**
   * Spawns the Go backend binary or go run command with appropriate environment variables.
   */
  private async spawnBackendServer(): Promise<void> {
    const isPackaged = app.isPackaged
    const workspaceRoot = isPackaged
      ? path.join(process.resourcesPath, 'workspace')
      : path.resolve(__dirname, '../../../../workspace')

    const runtimePath = path.join(workspaceRoot, '.dev-sqlite')
    const dbPath = path.join(runtimePath, 'workspace.db')
    const filesPath = path.join(runtimePath, 'files')

    if (!fs.existsSync(runtimePath)) {
      fs.mkdirSync(runtimePath, { recursive: true })
    }
    if (!fs.existsSync(filesPath)) {
      fs.mkdirSync(filesPath, { recursive: true })
    }

    const env = {
      ...process.env,
      CGO_ENABLED: '0',
      DATABASE_URL: `sqlite://${dbPath.replace(/\\/g, '/')}`,
      AUTH_MODE: process.env.AUTH_MODE || 'workspace_token',
      CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:3005,http://localhost:3001,http://localhost:3000,app://.',
      FILE_STORAGE_PATH: filesPath,
      REQUESTS_PER_MINUTE: process.env.REQUESTS_PER_MINUTE || '1000',
      ROUTER_LLM_ENABLED: process.env.ROUTER_LLM_ENABLED || 'true',
    }

    const binaryName = process.platform === 'win32' ? 'server.exe' : 'server'
    const packagedBinary = path.join(process.resourcesPath, 'bin', binaryName)
    const localBackendDir = path.join(workspaceRoot, 'backend')

    const isGoRun = !fs.existsSync(packagedBinary) && fs.existsSync(localBackendDir)
    const recordedName = isGoRun ? (process.platform === 'win32' ? 'go.exe' : 'go') : binaryName

    // Avoid stdout/stderr pipe buffer deadlocks by setting stdio to 'ignore'
    const spawnOpts = {
      env,
      stdio: 'ignore' as const,
      detached: process.platform !== 'win32', // Detached process group on POSIX for clean tree kills
    }

    if (fs.existsSync(packagedBinary)) {
      this.childProcess = spawn(packagedBinary, [], spawnOpts)
    } else if (fs.existsSync(localBackendDir)) {
      const goCmd = process.platform === 'win32' ? 'go.exe' : 'go'
      this.childProcess = spawn(goCmd, ['run', './cmd/server'], {
        cwd: localBackendDir,
        ...spawnOpts,
      })
    } else {
      console.error('[BackendManager] Neither binary nor backend source directory found!')
      return
    }

    if (this.childProcess && this.childProcess.pid) {
      const pidRecord: PidRecord = {
        pid: this.childProcess.pid,
        name: recordedName,
        time: Date.now(),
      }
      try {
        fs.writeFileSync(this.getPidFilePath(), JSON.stringify(pidRecord), 'utf8')
      } catch (err) {
        console.warn('[BackendManager] Failed to record backend PID:', err)
      }

      this.childProcess.on('exit', (code) => {
        console.log(`[BackendManager] Backend child process exited with code ${code}`)
        this.childProcess = null
        try {
          const pidFile = this.getPidFilePath()
          if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
        } catch {}
      })
    }
  }

  /**
   * Cleanly terminates the spawned child process on app exit.
   */
  public stopBackend(): void {
    if (this.childProcess && this.childProcess.pid) {
      console.log('[BackendManager] Terminating spawned backend child process...')
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', this.childProcess.pid.toString(), '/T', '/F'], { stdio: 'ignore' })
        } else {
          try {
            process.kill(-this.childProcess.pid, 'SIGKILL')
          } catch {
            this.childProcess.kill('SIGKILL')
          }
        }
      } catch (err) {
        console.error('[BackendManager] Error stopping child process:', err)
      }
      this.childProcess = null
    }

    // Clean up PID file
    try {
      const pidFile = this.getPidFilePath()
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
    } catch {}
  }
}

export const backendManager = new BackendManager()
