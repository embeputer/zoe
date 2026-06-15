const { spawn } = require('child_process');
const { createServer } = require('./server');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3010);
const url = `http://${HOST}:${PORT}/face-debug.html`;

function openBrowser(targetUrl) {
  const platform = process.platform;
  const command = platform === 'darwin'
    ? 'open'
    : platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', targetUrl] : [targetUrl];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log(`Open this URL manually: ${targetUrl}`);
  });
  child.unref();
}

const server = createServer();
server.listen(PORT, HOST, () => {
  console.log(`Zoe face debug listening on ${url}`);
  openBrowser(url);
});

