// server/server.js
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import net from 'net';
import dgram from 'dgram';

const app = express();
app.use(express.json());
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173'] }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: ['http://localhost:3000', 'http://localhost:5173'] }
});

/* --------------------- SERIAL (existing) --------------------- */
let serial = null;
let serialParser = null;

app.get('/ports', async (_req, res) => {
  try {
    const list = await SerialPort.list();

    console.log('--- SerialPort.list() raw ---');
    console.log(list); // Full objects from the OS/driver

    const mapped = list.map(p => ({
      path: p.path,
      friendlyName: p.friendlyName ?? null,
      manufacturer: p.manufacturer ?? null,
      serialNumber: p.serialNumber ?? null,
      vendorId: p.vendorId ?? null,
      productId: p.productId ?? null
    }));

    console.log('--- /ports response ---');
    console.log(mapped);
    res.json(mapped);
  } catch (e) {
    console.error('Error in /ports:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/open', (req, res) => {
  const {
    path, baudRate = 9600, dataBits = 8, stopBits = 1,
    parity = 'none', rtscts = false, delimiter = '\r\n'
  } = req.body;

  if (serial?.isOpen) return res.status(400).json({ error: 'Serial port already open' });

  serial = new SerialPort({ path, baudRate, dataBits, stopBits, parity, rtscts, autoOpen: false });
  serial.on('error', e => io.emit('serial_err', e.message));
  serial.on('close', () => io.emit('serial_close'));

  serialParser = serial.pipe(new ReadlineParser({ delimiter }));
  serialParser.on('data', line => io.emit('serial_rx', line));

  serial.open(err => {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('serial_open', { path, baudRate, dataBits, stopBits, parity, rtscts });
    res.json({ ok: true });
  });
});

app.post('/send', (req, res) => {
  const { data, appendDelimiter = true, delimiter = '\r\n' } = req.body;
  if (!serial?.isOpen) return res.status(400).json({ error: 'Serial port not open' });

  const payload = Buffer.from(appendDelimiter ? `${data}${delimiter}` : data, 'utf8');
  serial.write(payload, (e) => {
    if (e) return res.status(500).json({ error: e.message });
    io.emit('serial_tx', data);
    res.json({ ok: true });
  });
});

app.post('/close', (_req, res) => {
  if (!serial?.isOpen) return res.json({ ok: true });
  serial.close(() => {
    io.emit('serial_close');
    serial = null;
    serialParser = null;
    res.json({ ok: true });
  });
});

/* --------------------- ETHERNET: TCP client --------------------- */
let tcpClient = null;

app.post('/tcp/connect', (req, res) => {
  const { host = '127.0.0.1', port = 9100 } = req.body;
  if (tcpClient && !tcpClient.destroyed) {
    return res.status(400).json({ error: 'TCP already connected' });
  }

  tcpClient = new net.Socket();

  tcpClient.on('connect', () => {
    io.emit('tcp_open', { host, port });
  });
  tcpClient.on('data', (buf) => {
    io.emit('tcp_rx', buf.toString('utf8')); // change to Array.from(buf) if you need raw
  });
  tcpClient.on('error', (err) => {
    io.emit('tcp_err', err.message);
  });
  tcpClient.on('close', () => {
    io.emit('tcp_close');
  });

  tcpClient.connect(port, host, () => {
    res.json({ ok: true });
  });
});

app.post('/tcp/send', (req, res) => {
  const { data = '', appendNewline = true } = req.body;
  if (!tcpClient || tcpClient.destroyed) {
    return res.status(400).json({ error: 'TCP not connected' });
  }
  const payload = Buffer.from(appendNewline ? `${data}\n` : data, 'utf8');
  tcpClient.write(payload, (e) => {
    if (e) return res.status(500).json({ error: e.message });
    io.emit('tcp_tx', data);
    res.json({ ok: true });
  });
});

app.post('/tcp/close', (_req, res) => {
  if (!tcpClient || tcpClient.destroyed) return res.json({ ok: true });
  tcpClient.end(() => res.json({ ok: true }));
});

app.post('/tcp/speedtest', async (req, res) => {
  if (!tcpClient || tcpClient.destroyed)
    return res.status(400).json({ error: 'TCP not connected' });

  const size = 5 * 1024 * 1024; // 5 MB
  const payload = Buffer.alloc(size, 'A');

  const start = Date.now();

  tcpClient.write(payload, (err) => {
    if (err) return res.status(500).json({ error: err.message });

    const end = Date.now();
    const seconds = (end - start) / 1000;
    const mbps = (size / 1024 / 1024) / seconds;

    res.json({
      uploadedMB: size / 1024 / 1024,
      timeSec: seconds,
      speedMbps: mbps.toFixed(2)
    });
  });
});


/* --------------------- ETHERNET: UDP client --------------------- */
let udpSocket = null;
let udpDefaultRemote = null; // { host, port }

app.post('/udp/bind', (req, res) => {
  const { localPort = 0, remoteHost = '127.0.0.1', remotePort = 9200 } = req.body;

  if (udpSocket) {
    return res.status(400).json({ error: 'UDP already bound' });
  }

  udpDefaultRemote = { host: remoteHost, port: remotePort };
  udpSocket = dgram.createSocket('udp4');

  udpSocket.on('listening', () => {
    const addr = udpSocket.address();
    io.emit('udp_bind', { localPort: addr.port });
  });

  udpSocket.on('message', (msg, rinfo) => {
    io.emit('udp_rx', { from: `${rinfo.address}:${rinfo.port}`, data: msg.toString('utf8') });
  });

  udpSocket.on('error', (err) => {
    io.emit('udp_err', err.message);
  });

  udpSocket.on('close', () => {
    io.emit('udp_close');
  });

  udpSocket.bind(localPort, () => res.json({ ok: true }));
});

app.post('/udp/send', (req, res) => {
  if (!udpSocket) return res.status(400).json({ error: 'UDP not bound' });

  const { data = '', host, port } = req.body;
  const dest = { ...(udpDefaultRemote || {}), ...(host ? { host } : {}), ...(port ? { port } : {}) };
  if (!dest.host || !dest.port) return res.status(400).json({ error: 'No destination host/port' });

  const buf = Buffer.from(data, 'utf8');
  udpSocket.send(buf, dest.port, dest.host, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('udp_tx', { to: `${dest.host}:${dest.port}`, data });
    res.json({ ok: true });
  });
});

app.post('/udp/close', (_req, res) => {
  if (!udpSocket) return res.json({ ok: true });
  udpSocket.close(() => {
    udpSocket = null;
    udpDefaultRemote = null;
    res.json({ ok: true });
  });
});

/* --------------------- Optional: Local echo servers for testing --------------------- */
let tcpEchoServer = null;
let udpEchoSocket = null;

app.post('/tcp-echo/start', (req, res) => {
  const { port = 9100 } = req.body;
  if (tcpEchoServer) return res.status(400).json({ error: 'TCP echo already running' });

  tcpEchoServer = net.createServer((socket) => {
    socket.on('data', (data) => socket.write(data)); // echo
  });
  tcpEchoServer.on('listening', () => io.emit('tcp_echo_listening', { port }));
  tcpEchoServer.on('error', (e) => io.emit('tcp_echo_err', e.message));
  tcpEchoServer.listen(port, () => res.json({ ok: true }));
});

app.post('/tcp-echo/stop', (_req, res) => {
  if (!tcpEchoServer) return res.json({ ok: true });
  tcpEchoServer.close(() => {
    tcpEchoServer = null;
    res.json({ ok: true });
  });
});

app.post('/udp-echo/start', (req, res) => {
  const { port = 9200 } = req.body;
  if (udpEchoSocket) return res.status(400).json({ error: 'UDP echo already running' });

  udpEchoSocket = dgram.createSocket('udp4');
  udpEchoSocket.on('message', (msg, rinfo) => {
    // echo back to sender
    udpEchoSocket.send(msg, rinfo.port, rinfo.address);
  });
  udpEchoSocket.on('listening', () => {
    const addr = udpEchoSocket.address();
    io.emit('udp_echo_listening', { port: addr.port });
  });
  udpEchoSocket.on('error', (e) => io.emit('udp_echo_err', e.message));
  udpEchoSocket.bind(port, () => res.json({ ok: true }));
});

app.post('/udp-echo/stop', (_req, res) => {
  if (!udpEchoSocket) return res.json({ ok: true });
  udpEchoSocket.close(() => {
    udpEchoSocket = null;
    res.json({ ok: true });
  });
});


const PORT = 3001;
(async () => {
  try {
    const ports = await SerialPort.list();
    console.log('Ports at startup:', ports);
  } catch (e) {
    console.error('Startup list failed:', e);
  }
})();
server.listen(PORT, () => {
  console.log(`Serial/Ethernet server listening on http://localhost:${PORT}`);
});
