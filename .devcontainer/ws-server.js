import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';

const execAsync = promisify(exec);
const PORT = 8080;

// Terminal session management
const terminalSessions = new Map();
let ptyModule = null;

// Try to load node-pty for proper terminal support
try {
  const mod = await import('node-pty');
  ptyModule = mod.default || mod;
  // Verify the spawn function actually exists
  if (typeof ptyModule.spawn !== 'function') {
    throw new Error('spawn function not found on node-pty module');
  }
  console.log('✅ node-pty loaded - full terminal support available');
} catch (e) {
  ptyModule = null;
  console.log('⚠️  node-pty not available (' + e.message + ') - install with: npm install node-pty');
}

// JWT Public Key(s) for token verification (RS256)
// Supports multiple keys for rolling key rotation
const jwtPublicKeys = [];
const PHANTOMWP_URL = process.env.PHANTOMWP_URL || 'https://phantomwp.com';
const KEY_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // Refresh keys every 6 hours

function isValidPublicKey(key) {
  return key && (key.includes('BEGIN PUBLIC KEY') || key.includes('BEGIN RSA PUBLIC KEY'));
}

// Load initial key from environment
const envKey = process.env.JWT_PUBLIC_KEY;
if (envKey && isValidPublicKey(envKey)) {
  jwtPublicKeys.push(envKey);
  console.log('🔐 JWT public key loaded from environment');
} else if (envKey) {
  console.error('⚠️  JWT_PUBLIC_KEY from environment is not a valid PEM public key');
}

// Fetch keys from the PhantomWP API (supports key rotation)
async function refreshPublicKeys() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(PHANTOMWP_URL + '/api/keys/public', { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error('⚠️  Key refresh: API returned ' + res.status);
      return;
    }
    const data = await res.json();
    if (!data.keys || !Array.isArray(data.keys)) return;

    const newKeys = data.keys
      .map(k => k.key)
      .filter(k => isValidPublicKey(k));

    if (newKeys.length > 0) {
      // Replace the key list with the fresh set from the API
      jwtPublicKeys.length = 0;
      newKeys.forEach(k => jwtPublicKeys.push(k));
      console.log('🔑 Refreshed ' + newKeys.length + ' public key(s) from API');
    }
  } catch (error) {
    // Network errors are expected when the main app is unreachable; not fatal
    if (error.name !== 'AbortError') {
      console.error('⚠️  Key refresh failed:', error.message);
    }
  }
}

// Try an initial fetch (non-blocking -- we already have the env key as fallback)
refreshPublicKeys().catch(() => {});

// Periodically refresh keys to pick up rotations
setInterval(() => { refreshPublicKeys().catch(() => {}); }, KEY_REFRESH_INTERVAL);

if (jwtPublicKeys.length === 0) {
  console.error('❌ No JWT public keys available');
  console.error('');
  console.error('This codespace requires JWT authentication to be set up.');
  console.error('The public key should be fetched automatically from the PhantomWP API.');
  console.error('');
  console.error('If you see this error:');
  console.error('  1. Try recreating the codespace from the PhantomWP dashboard');
  console.error('  2. Check that the main app has JWT_PUBLIC_KEY set');
  console.error('');
  process.exit(1);
}

console.log('🔐 ' + jwtPublicKeys.length + ' JWT public key(s) loaded for WebSocket authentication');
console.log('   Using RS256 asymmetric verification');
console.log('   Keys refresh every ' + (KEY_REFRESH_INTERVAL / 3600000) + ' hours from ' + PHANTOMWP_URL);

// Pending IDE command responses (for request/response commands like get-open-tabs)
const pendingResponses = new Map();

// HTTP server for IDE command bridge (localhost only, used by MCP server)
const httpServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ide-command') {
    // Only allow localhost connections (MCP server runs locally)
    const addr = req.socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
      return;
    }
    let body = '';
    const MAX_BODY = 4096;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const command = JSON.parse(body);
        // For commands that expect a response, add a request ID and wait
        const needsResponse = command.command === 'get-open-tabs';
        const requestId = needsResponse ? Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : null;
        if (requestId) command._requestId = requestId;

        // Broadcast to all authenticated WebSocket clients
        let sent = 0;
        for (const client of wss.clients) {
          if (client.readyState === 1 && client.username) {
            client.send(JSON.stringify({ action: 'ide-command', ...command }));
            sent++;
          }
        }

        if (needsResponse && sent > 0) {
          // Wait up to 3s for IDE to respond
          const timeout = setTimeout(() => {
            pendingResponses.delete(requestId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, clients: sent, data: null }));
          }, 3000);
          pendingResponses.set(requestId, { res, timeout });
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, clients: sent }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(PORT);

const wss = new WebSocketServer({ 
  server: httpServer,
  maxPayload: 50 * 1024 * 1024,
});

// Verify JWT token against all known public keys (RS256)
// Tries each key in order -- supports rolling key rotation
function verifyToken(token) {
  let lastError = null;
  for (const key of jwtPublicKeys) {
    try {
      const decoded = jwt.verify(token, key, { algorithms: ['RS256'] });
      return { valid: true, payload: decoded };
    } catch (error) {
      lastError = error;
    }
  }
  console.error('JWT verification failed against all ' + jwtPublicKeys.length + ' key(s):', lastError?.message);
  return { valid: false, error: lastError?.message || 'No valid keys' };
}

// Extract token from URL query parameter
function authenticateConnection(req) {
  try {
    const url = new URL(req.url, 'ws://localhost');
    const token = url.searchParams.get('token');
    
    if (!token) {
      console.error('❌ No token provided in connection URL');
      return null;
    }
    
    const result = verifyToken(token);
    if (!result.valid) {
      console.error('❌ Invalid token:', result.error);
      return null;
    }
    
    return {
      userId: result.payload.userId,
      username: result.payload.username || 'unknown',
      repoId: result.payload.repoId,
      repoName: result.payload.repoName,
    };
  } catch (error) {
    console.error('❌ Authentication error:', error.message);
    return null;
  }
}

// Path validation to prevent traversal attacks
function isPathSafe(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.includes('../') || normalized.includes('/..') || normalized === '..') return false;
  if (normalized.startsWith('.git/') || normalized === '.git') return false;
  if (normalized.startsWith('node_modules/') || normalized === 'node_modules') return false;
  return true;
}

// List files in a directory (recursive)
async function listDirectory(dirPath, basePath = '') {
  const files = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.astro' && entry.name !== '.devcontainer') continue;
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      
      const relativePath = basePath ? basePath + '/' + entry.name : entry.name;
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: true,
        });
        const subFiles = await listDirectory(fullPath, relativePath);
        files.push(...subFiles);
      } else {
        files.push({
          name: entry.name,
          path: relativePath,
          isDirectory: false,
        });
      }
    }
  } catch (error) {
    console.error('Error listing directory ' + dirPath + ':', error.message);
  }
  return files;
}

// Handle client connection
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log('🔌 New connection from ' + clientIp);
  
  // Authenticate on connection via URL token
  const authData = authenticateConnection(req);
  
  if (!authData) {
    console.error('❌ Unauthorized connection attempt from ' + clientIp);
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  // Store auth data on connection
  ws.userId = authData.userId;
  ws.username = authData.username;
  ws.repoId = authData.repoId;
  ws.repoName = authData.repoName;
  
  console.log('✅ Client connected: ' + authData.username + ' (' + authData.repoName + ')');

  // Connection health
  let isAlive = true;
  
  ws.on('ping', () => { ws.pong(); });
  ws.on('pong', () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      clearInterval(pingInterval);
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
  }, 20000);

  ws.on('message', async (message) => {
    try {
      const messageStr = typeof message === 'string' ? message : message.toString('utf8');
      const data = JSON.parse(messageStr);
      const username = ws.username || 'unknown';
      
      // Handle ping action
      if (data.action === 'ping') {
        ws.send(JSON.stringify({ action: 'pong' }));
        return;
      }

      // Handle IDE command responses (request/response pattern)
      if (data.action === 'ide-response' && data._requestId) {
        const pending = pendingResponses.get(data._requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingResponses.delete(data._requestId);
          pending.res.writeHead(200, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ success: true, data: data.data || null }));
        }
        return;
      }
      
      // Validate path
      if (data.path && !isPathSafe(data.path)) {
        ws.send(JSON.stringify({
          action: data.action,
          path: data.path,
          error: 'Invalid file path',
          success: false,
        }));
        console.error('❌ Path traversal attempt blocked: ' + data.path + ' (user: ' + username + ')');
        return;
      }
      
      // Handle file operations (using 'action' protocol)
      switch (data.action) {
        case 'read':
          try {
            let content;
            if (data.encoding === 'base64') {
              const buffer = await fs.readFile(data.path);
              content = buffer.toString('base64');
            } else {
              content = await fs.readFile(data.path, 'utf8');
            }
            ws.send(JSON.stringify({
              action: 'read',
              path: data.path,
              content,
              encoding: data.encoding || 'utf8',
              success: true,
            }));
            console.log('📖 [' + username + '] Read file: ' + data.path + (data.encoding === 'base64' ? ' (base64)' : ''));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'read',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'write':
          try {
            const dirname = path.dirname(data.path);
            await fs.mkdir(dirname, { recursive: true });
            
            if (data.encoding === 'base64') {
              const buffer = Buffer.from(data.content, 'base64');
              await fs.writeFile(data.path, buffer);
            } else {
              await fs.writeFile(data.path, data.content, 'utf8');
            }
            
            // Touch global.css to trigger Tailwind CSS rebuild for files that might contain classes
            // This fixes a race condition where Vite's eager glob imports can cache CSS before
            // Tailwind has scanned new files for arbitrary values like h-[56px], w-[200px], etc.
            const tailwindTriggerExtensions = ['.astro', '.tsx', '.jsx', '.html', '.mdx', '.md', '.vue', '.svelte'];
            if (tailwindTriggerExtensions.some(ext => data.path.endsWith(ext))) {
              try {
                const now = new Date();
                await fs.utimes('src/styles/global.css', now, now);
              } catch (e) {
                // Ignore if global.css doesn't exist
              }
            }
            
            ws.send(JSON.stringify({
              action: 'write',
              path: data.path,
              success: true,
            }));
            console.log('💾 [' + username + '] Wrote file: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'write',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'list':
          try {
            const targetPath = data.path === '.' ? process.cwd() : path.join(process.cwd(), data.path);
            const files = await listDirectory(targetPath, data.path === '.' ? '' : data.path);
            ws.send(JSON.stringify({
              action: 'list',
              path: data.path,
              files,
              success: true,
            }));
            console.log('📂 [' + username + '] Listed directory: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'list',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'delete':
          try {
            const stats = await fs.stat(data.path);
            if (stats.isDirectory()) {
              await fs.rm(data.path, { recursive: true, force: true });
            } else {
              await fs.unlink(data.path);
            }
            ws.send(JSON.stringify({
              action: 'delete',
              path: data.path,
              success: true,
            }));
            console.log('🗑️ [' + username + '] Deleted: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'delete',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'rename':
          try {
            if (!data.oldPath || !data.newPath) {
              throw new Error('oldPath and newPath are required');
            }
            if (!isPathSafe(data.oldPath) || !isPathSafe(data.newPath)) {
              throw new Error('Invalid path');
            }
            const newDir = path.dirname(data.newPath);
            await fs.mkdir(newDir, { recursive: true });
            await fs.rename(data.oldPath, data.newPath);
            ws.send(JSON.stringify({
              action: 'rename',
              oldPath: data.oldPath,
              newPath: data.newPath,
              success: true,
            }));
            console.log('📝 [' + username + '] Renamed: ' + data.oldPath + ' → ' + data.newPath);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'rename',
              oldPath: data.oldPath,
              newPath: data.newPath,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'create':
          try {
            const dirname = path.dirname(data.path);
            await fs.mkdir(dirname, { recursive: true });
            await fs.writeFile(data.path, data.content || '', 'utf8');
            
            // Touch global.css to trigger Tailwind CSS rebuild (same as write action)
            const tailwindTriggerExts = ['.astro', '.tsx', '.jsx', '.html', '.mdx', '.md', '.vue', '.svelte'];
            if (tailwindTriggerExts.some(ext => data.path.endsWith(ext))) {
              try {
                const now = new Date();
                await fs.utimes('src/styles/global.css', now, now);
              } catch (e) {
                // Ignore if global.css doesn't exist
              }
            }
            
            ws.send(JSON.stringify({
              action: 'create',
              path: data.path,
              success: true,
            }));
            console.log('✨ [' + username + '] Created file: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'create',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'mkdir':
          try {
            await fs.mkdir(data.path, { recursive: true });
            ws.send(JSON.stringify({
              action: 'mkdir',
              path: data.path,
              success: true,
            }));
            console.log('📁 [' + username + '] Created directory: ' + data.path);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'mkdir',
              path: data.path,
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git':
          try {
            const { command } = data;
            const allowedCommands = ['status', 'diff', 'log', 'branch', 'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'stash'];
            const gitCommand = command.split(' ')[0];
            if (!allowedCommands.includes(gitCommand)) {
              throw new Error('Git command not allowed');
            }
            const { stdout, stderr } = await execAsync('git ' + command, { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git',
              success: true,
              stdout,
              stderr,
            }));
            console.log('🔀 [' + username + '] Git: ' + command);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'gitStatus':
          try {
            const { stdout } = await execAsync('git status --porcelain', { cwd: process.cwd() });
            const changes = stdout.trim().split('\n').filter(line => line.length > 0);
            ws.send(JSON.stringify({
              action: 'gitStatus',
              success: true,
              changes: changes.length,
              files: changes,
            }));
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'gitStatus',
              success: true,
              changes: 0,
              files: [],
            }));
          }
          break;

        case 'git-status':
          try {
            const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: process.cwd() });
            const statusLines = statusOutput.trim().split('\n').filter(line => line.length > 0);
            const parsedChanges = statusLines.map(line => {
              const status = line.substring(0, 2);
              const file = line.substring(3);
              let type = 'modified';
              if (status.includes('?')) type = 'untracked';
              else if (status.includes('A')) type = 'added';
              else if (status.includes('D')) type = 'deleted';
              else if (status.includes('R')) type = 'renamed';
              else if (status.includes('M')) type = 'modified';
              return { file, status, type };
            });
            ws.send(JSON.stringify({
              action: 'git-status',
              success: true,
              changes: parsedChanges,
            }));
            console.log('🔀 [' + username + '] Git status: ' + parsedChanges.length + ' changes');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-status',
              success: false,
              error: error.message,
              changes: [],
            }));
          }
          break;

        case 'git-diff':
          try {
            const { file: diffFile } = data;
            if (!diffFile) {
              throw new Error('File path is required for git-diff');
            }
            const { stdout: diffOutput } = await execAsync('git diff -- ' + JSON.stringify(diffFile), { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-diff',
              success: true,
              file: diffFile,
              diff: diffOutput,
            }));
            console.log('🔀 [' + username + '] Git diff: ' + diffFile);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-diff',
              success: false,
              error: error.message,
              diff: '',
            }));
          }
          break;

        case 'git-commit':
          try {
            const { message: commitMsg } = data;
            if (!commitMsg) {
              throw new Error('Commit message is required');
            }
            // First, stage all changes
            await execAsync('git add -A', { cwd: process.cwd() });
            // Then commit with the message
            const { stdout: commitOutput } = await execAsync('git commit -m ' + JSON.stringify(commitMsg), { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-commit',
              success: true,
              message: commitMsg,
              output: commitOutput,
            }));
            console.log('🔀 [' + username + '] Git commit: ' + commitMsg);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-commit',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-push':
          try {
            const { stdout: pushOutput, stderr: pushStderr } = await execAsync('git push', { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-push',
              success: true,
              output: pushOutput || pushStderr,
            }));
            console.log('🔀 [' + username + '] Git push completed');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-push',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'git-pull-force':
          try {
            // Fetch from origin and reset to match remote
            await execAsync('git fetch origin', { cwd: process.cwd() });
            // Get the current branch name
            const { stdout: branchOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: process.cwd() });
            const currentBranch = branchOutput.trim();
            // Reset hard to origin branch
            const { stdout: resetOutput, stderr: resetStderr } = await execAsync('git reset --hard origin/' + currentBranch, { cwd: process.cwd() });
            ws.send(JSON.stringify({
              action: 'git-pull-force',
              success: true,
              branch: currentBranch,
              output: resetOutput || resetStderr,
            }));
            console.log('🔀 [' + username + '] Git pull force completed (branch: ' + currentBranch + ')');
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'git-pull-force',
              success: false,
              error: error.message,
            }));
          }
          break;

        case 'exec':
          try {
            const { command: execCommand } = data;
            if (!execCommand) {
              throw new Error('Command is required');
            }
            const { stdout: execOutput, stderr: execStderr } = await execAsync(execCommand, { 
              cwd: process.cwd(),
              timeout: 120000,  // 2 minute timeout for npm install
            });
            ws.send(JSON.stringify({
              action: 'exec',
              success: true,
              command: execCommand,
              output: execOutput || execStderr,
            }));
            console.log('⚡ [' + username + '] Exec: ' + execCommand);
          } catch (error) {
            ws.send(JSON.stringify({
              action: 'exec',
              success: false,
              command: data.command,
              error: error.message,
            }));
            console.error('❌ [' + username + '] Exec failed: ' + error.message);
          }
          break;

        case 'terminal-open': {
          try {
            const termId = data.id || 'default';
            
            // Kill existing session if any
            if (terminalSessions.has(termId)) {
              const old = terminalSessions.get(termId);
              try { old.kill(); } catch {}
              terminalSessions.delete(termId);
            }

            const cols = data.cols || 80;
            const rows = data.rows || 24;
            const cwd = process.cwd();
            const shell = process.env.SHELL || '/bin/bash';

            let ptyProcess;
            if (ptyModule) {
              // Full PTY with node-pty
              ptyProcess = ptyModule.spawn(shell, ['-l'], {
                name: 'xterm-256color',
                cols,
                rows,
                cwd,
                env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
              });

              ptyProcess.onData((output) => {
                try {
                  ws.send(JSON.stringify({ action: 'terminal-output', id: termId, data: output }));
                } catch {}
              });

              ptyProcess.onExit(({ exitCode }) => {
                terminalSessions.delete(termId);
                try {
                  ws.send(JSON.stringify({ action: 'terminal-exit', id: termId, exitCode }));
                } catch {}
              });
            } else {
              // Fallback: basic shell without PTY
              const child = spawn(shell, ['-l'], {
                cwd,
                env: { ...process.env, TERM: 'xterm-256color' },
                stdio: ['pipe', 'pipe', 'pipe'],
              });

              // Wrap child to match pty interface
              ptyProcess = {
                write: (d) => child.stdin.write(d),
                resize: () => {},
                kill: () => child.kill(),
                pid: child.pid,
              };

              child.stdout.on('data', (output) => {
                try {
                  ws.send(JSON.stringify({ action: 'terminal-output', id: termId, data: output.toString() }));
                } catch {}
              });

              child.stderr.on('data', (output) => {
                try {
                  ws.send(JSON.stringify({ action: 'terminal-output', id: termId, data: output.toString() }));
                } catch {}
              });

              child.on('exit', (exitCode) => {
                terminalSessions.delete(termId);
                try {
                  ws.send(JSON.stringify({ action: 'terminal-exit', id: termId, exitCode }));
                } catch {}
              });
            }

            terminalSessions.set(termId, ptyProcess);
            ws.send(JSON.stringify({ action: 'terminal-open', id: termId, success: true, pid: ptyProcess.pid }));
            console.log('🖥️  [' + username + '] Terminal opened: ' + termId + ' (pid: ' + ptyProcess.pid + ')');
          } catch (error) {
            ws.send(JSON.stringify({ action: 'terminal-open', id: data.id || 'default', success: false, error: error.message }));
            console.error('❌ Terminal open failed:', error.message);
          }
          break;
        }

        case 'terminal-input': {
          const termId = data.id || 'default';
          const session = terminalSessions.get(termId);
          if (session && data.data) {
            session.write(data.data);
          }
          break;
        }

        case 'terminal-resize': {
          const termId = data.id || 'default';
          const session = terminalSessions.get(termId);
          if (session && data.cols && data.rows) {
            try { session.resize(data.cols, data.rows); } catch {}
          }
          break;
        }

        case 'terminal-close': {
          const termId = data.id || 'default';
          const session = terminalSessions.get(termId);
          if (session) {
            try { session.kill(); } catch {}
            terminalSessions.delete(termId);
            console.log('🖥️  [' + username + '] Terminal closed: ' + termId);
          }
          ws.send(JSON.stringify({ action: 'terminal-close', id: termId, success: true }));
          break;
        }

        default:
          console.log('Unknown action: ' + data.action);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ action: 'error', error: error.message, success: false }));
    }
  });
  
  ws.on('close', () => {
    clearInterval(pingInterval);
    // Clean up terminal sessions for this connection
    for (const [id, session] of terminalSessions.entries()) {
      try { session.kill(); } catch {}
      terminalSessions.delete(id);
    }
    console.log('🔌 Client disconnected: ' + ws.username);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(pingInterval);
  });
});

console.log('🔌 WebSocket server running on port ' + PORT);
console.log('🌐 IDE command bridge available at http://localhost:' + PORT + '/ide-command');
console.log('📁 Watching directory:', process.cwd());
