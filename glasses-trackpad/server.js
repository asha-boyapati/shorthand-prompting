// glasses-trackpad prototype server
// Serves the glasses display page + phone trackpad page, and relays
// gesture messages between them over WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROUTES = {
  '/display': 'display.html',
  '/trackpad': 'trackpad.html',
  '/quiz': 'quiz.html',
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/') {
    res.writeHead(302, { Location: '/display' });
    res.end();
    return;
  }

  const file = ROUTES[url];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /display, /quiz or /trackpad');
    return;
  }

  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading ' + file);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// --- WebSocket relay ---------------------------------------------------
// Clients identify themselves with {type:"hello", role:"display"|"trackpad"}.
// Messages from trackpads are relayed to displays; "ack" messages from
// displays are relayed back to trackpads. Connection status is broadcast
// to both sides whenever the roster changes.

const wss = new WebSocketServer({ server });
const clients = new Set(); // { ws, role }

function countRole(role) {
  let n = 0;
  for (const c of clients) if (c.role === role) n++;
  return n;
}

function sendTo(role, msg) {
  const raw = JSON.stringify(msg);
  for (const c of clients) {
    if (c.role === role && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(raw);
    }
  }
}

function broadcastStatus() {
  const status = {
    type: 'status',
    displays: countRole('display'),
    trackpads: countRole('trackpad'),
  };
  sendTo('display', status);
  sendTo('trackpad', status);
}

wss.on('connection', (ws) => {
  const client = { ws, role: null };
  clients.add(client);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      client.role = msg.role === 'display' ? 'display' : 'trackpad';
      console.log(`[ws] ${client.role} connected (displays=${countRole('display')}, trackpads=${countRole('trackpad')})`);
      broadcastStatus();
      return;
    }

    // Relay gestures from trackpads to displays, acks from displays back.
    if (client.role === 'trackpad') {
      sendTo('display', msg);
    } else if (client.role === 'display' && msg.type === 'ack') {
      sendTo('trackpad', msg);
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    if (client.role) {
      console.log(`[ws] ${client.role} disconnected`);
      broadcastStatus();
    }
  });

  ws.on('error', () => {});
});

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIP();
  console.log('');
  console.log('  glasses-trackpad prototype');
  console.log('  ==========================');
  console.log(`  Glasses display (laptop):  http://localhost:${PORT}/display`);
  console.log(`  Quiz mode (laptop):        http://localhost:${PORT}/quiz`);
  console.log(`  Trackpad (phone, same wifi): http://${ip}:${PORT}/trackpad`);
  console.log('');
});
