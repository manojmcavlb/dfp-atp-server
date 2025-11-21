// routes/serialRoutes.js
import express from 'express';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const router = express.Router();

let serial = null;
let serialParser = null;

/* ----------- LIST PORTS ----------- */
router.get('/ports', async (_req, res) => {
  try {
    const list = await SerialPort.list();
    const mapped = list.map(p => ({
      path: p.path,
      friendlyName: p.friendlyName ?? null,
      manufacturer: p.manufacturer ?? null,
      serialNumber: p.serialNumber ?? null,
      vendorId: p.vendorId ?? null,
      productId: p.productId ?? null
    }));

    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ----------- OPEN SERIAL ----------- */
router.post('/open', (req, res) => {
  const {
    path, baudRate = 9600, dataBits = 8, stopBits = 1,
    parity = 'none', rtscts = false, delimiter = '\r\n'
  } = req.body;

  if (serial?.isOpen) return res.status(400).json({ error: 'Already open' });

  serial = new SerialPort({ path, baudRate, dataBits, stopBits, parity, rtscts, autoOpen: false });

  serial.on('error', e => req.io.emit('serial_err', e.message));
  serial.on('close', () => req.io.emit('serial_close'));

  serialParser = serial.pipe(new ReadlineParser({ delimiter }));
  serialParser.on('data', line => req.io.emit('serial_rx', line));

  serial.open(err => {
    if (err) return res.status(500).json({ error: err.message });
    req.io.emit('serial_open', { path, baudRate, dataBits, stopBits, parity, rtscts });
    res.json({ ok: true });
  });
});

/* ----------- SEND SERIAL ----------- */
router.post('/send', (req, res) => {
  const { data, appendDelimiter = true, delimiter = '\r\n' } = req.body;
  if (!serial?.isOpen) return res.status(400).json({ error: 'Serial not open' });

  const payload = Buffer.from(appendDelimiter ? `${data}${delimiter}` : data, 'utf8');
  serial.write(payload, (e) => {
    if (e) return res.status(500).json({ error: e.message });
    req.io.emit('serial_tx', data);
    res.json({ ok: true });
  });
});

/* ----------- CLOSE SERIAL ----------- */
router.post('/close', (req, res) => {
  if (!serial?.isOpen) return res.json({ ok: true });
  serial.close(() => {
    req.io.emit('serial_close');
    serial = null;
    serialParser = null;
    res.json({ ok: true });
  });
});

export default router;
