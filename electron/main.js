const { app, BrowserWindow, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let mainWindow;
let nextProcess;

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(URL, (res) => {
      // 401 (MVS_PASSWORD) и 3xx тоже означают, что сервер поднялся
      const code = res.statusCode || 0;
      resolve(code === 200 || code === 401 || code === 302 || code === 301);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    const ok = await checkServer();
    if (ok) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function startNextServer() {
  console.log('[Electron] Starting Next.js server...');
  const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';
  
  if (isDev) {
    // In dev, assume npm run dev is already running or start it
    nextProcess = spawn('npm', ['run', 'dev', '--', '-H', '0.0.0.0', '-p', String(PORT)], {
      cwd: path.join(__dirname, '..'),
      shell: true,
      stdio: 'inherit'
    });
  } else {
    // In production, use next start
    nextProcess = spawn('npm', ['run', 'start', '--', '-H', '0.0.0.0', '-p', String(PORT)], {
      cwd: path.join(__dirname, '..'),
      shell: true,
      stdio: 'inherit'
    });
  }

  nextProcess.on('error', (err) => {
    console.error('[Electron] Failed to start Next server:', err);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0B0B0C',
    title: 'Manga Voice Studio',
    icon: path.join(__dirname, '../public/window.svg'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    show: false
  });

  // Minimal menu
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Перезагрузить', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: 'Настройки провайдеров', click: () => mainWindow.loadURL(`${URL}/settings`) },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'toggleDevTools', label: 'DevTools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Сброс зума' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { role: 'togglefullscreen', label: 'Полный экран' }
      ]
    },
    {
      label: 'Помощь',
      submenu: [
        { label: 'Открыть в браузере', click: () => shell.openExternal(URL) },
        { label: 'Документация', click: () => shell.openExternal('https://github.com/DMloaderJava/make') }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load URL after server ready
  waitForServer().then((ok) => {
    if (ok) {
      console.log('[Electron] Server ready, loading', URL);
      mainWindow.loadURL(URL);
    } else {
      console.error('[Electron] Server not ready after 30s');
      mainWindow.loadURL(URL); // try anyway
    }
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Check if server already running, if not start it
  checkServer().then((running) => {
    if (!running) {
      startNextServer();
    }
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function killTree(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      // try to kill process group
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill('SIGTERM');
      }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 2000);
    }
  } catch {
    try { proc.kill(); } catch {}
  }
}

app.on('window-all-closed', () => {
  if (nextProcess) {
    console.log('[Electron] Killing Next server tree');
    killTree(nextProcess);
    nextProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (nextProcess) {
    killTree(nextProcess);
    nextProcess = null;
  }
});
