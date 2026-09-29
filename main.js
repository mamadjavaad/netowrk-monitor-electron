const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const INPROCESS = process.argv.includes('--inprocess');
const FORCE_EXE = process.argv.includes('--exe');
const BACKEND_DIR = path.join(__dirname, '..', 'network-monitor-logic');
const BACKEND_ENTRY = path.join(BACKEND_DIR, 'src', 'index.js');
const PACKAGED_BACKEND = path.join(process.resourcesPath, 'network-monitor-logic', 'network-monitor.exe');
const DEV_BACKEND = path.join(BACKEND_DIR, 'dist', 'network-monitor.exe');

let backendProcess = null;
let logStream = null;

function resolveBackend() {
  if (app.isPackaged) return PACKAGED_BACKEND;
  if (FORCE_EXE) return DEV_BACKEND;
  return null;
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('Backend did not start in time');
}

function pipeBackendToLog(child) {
  const logFile = path.join(app.getPath('userData'), 'backend.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`\n--- backend started ${new Date().toISOString()} ---\n`);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  if (!app.isPackaged) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  console.log(`[Electron] Backend log: ${logFile}`);
}

function startSpawned() {
  const exe = resolveBackend();

  if (exe) {
    console.log(`[Electron] Mode: EXE — ${exe}`);
    if (!fs.existsSync(exe)) {
      throw new Error(`Backend executable not found: ${exe}`);
    }
    backendProcess = spawn(exe, [], {
      cwd: app.isPackaged ? app.getPath('temp') : BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    pipeBackendToLog(backendProcess);
  } else {
    console.log('[Electron] Mode: SPAWN — backend runs as a separate process, system Node.');
    console.log('[Electron] Native modules (better-sqlite3, cap) untouched — this is the known-working path.');
    backendProcess = spawn('node', [BACKEND_ENTRY], {
      cwd: BACKEND_DIR,
      stdio: 'inherit',
    });
  }

  backendProcess.on('error', (err) => {
    console.error('[Electron] Backend spawn error:', err);
  });
  backendProcess.on('exit', (code, signal) => {
    console.log(`[Electron] Backend process exited (code=${code} signal=${signal})`);
    backendProcess = null;
  });
}

async function startInProcess() {
  console.log('[Electron] Mode: IN-PROCESS — backend loaded into Electron\'s own Node/V8.');
  console.log('[Electron] This is the test: native modules must be rebuilt against Electron\'s ABI');
  console.log('[Electron] (run `npm run rebuild` first) or this will throw a NODE_MODULE_VERSION error.');

  await import(pathToFileURL(BACKEND_ENTRY).href);
}

function stopBackend() {
  if (backendProcess && backendProcess.exitCode === null && !backendProcess.killed) {
    try {
      backendProcess.kill();
    } catch (err) {
      console.error('[Electron] Failed to kill backend:', err);
    }
  }
  backendProcess = null;
  if (logStream) {
    try {
      logStream.end();
    } catch {
    }
    logStream = null;
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
  });

  app.whenReady().then(async () => {
    try {
      if (INPROCESS) {
        await startInProcess();
      } else {
        startSpawned();
      }

      await waitForServer('http://localhost:3000/health');

      const win = new BrowserWindow({ width: 1280, height: 800 });
      win.loadURL('http://localhost:3000');
    } catch (err) {
      console.error('[Electron] Failed to start:', err);
      const win = new BrowserWindow({ width: 900, height: 600 });
      win.loadURL(`data:text/html,<pre style="font-family:monospace;padding:2rem;white-space:pre-wrap">${encodeURIComponent(String(err.stack || err))}</pre>`);
    }
  });
}

app.on('window-all-closed', () => {
  stopBackend();
  app.quit();
});

app.on('will-quit', stopBackend);
