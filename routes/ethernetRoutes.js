// routes/ethernetRoutes.js
// Ethernet / TCP routes adapted for BK Precision 9801 SCPI-over-TCP
import express from 'express';
import net from 'net';

const router = express.Router();

let tcpClient = null;
let tcpClientInfo = { host: null, port: null };
let tcpBusy = false; // simple mutex to prevent concurrent command loops

/* ---------- Helpers ---------- */

/**
 * Ensure newline terminated command and write, then return immediately.
 */
function writeRaw(socket, data, appendNewline = true) {
  const payload = Buffer.from(appendNewline ? `${data}\n` : data, 'utf8');
  return new Promise((resolve, reject) => {
    try {
      const ok = socket.write(payload, (err) => {
        if (err) return reject(err);
        return resolve(ok);
      });
      // socket.write returns boolean; resolve after write callback too
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Send a single SCPI command on the given socket and wait for one newline-terminated response.
 * Resolves with { raw, rtt_ms, bytes, timeout, error }.
 * IMPORTANT: does not destroy socket on timeout; it returns timeout: true for the caller to decide.
 */
function sendCommandOnceOnSocket(socket, command, perCmdTimeoutMs = 3000) {
  return new Promise((resolve) => {
    let buffer = '';
    const start = Date.now();
    let finished = false;

    // event handlers
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (timer) clearTimeout(timer);
    }

    function onData(chunk) {
      try {
        buffer += chunk.toString('utf8');
      } catch (e) {
        buffer += String(chunk);
      }
      // instrument replies usually end with '\n' — treat first newline as end
      if (buffer.includes('\n')) {
        finished = true;
        cleanup();
        const rtt = Date.now() - start;
        return resolve({ raw: buffer.trim(), rtt_ms: rtt, bytes: Buffer.byteLength(buffer, 'utf8') });
      }
    }

    function onError(err) {
      if (finished) return;
      finished = true;
      cleanup();
      return resolve({ raw: buffer.trim(), rtt_ms: Date.now() - start, bytes: Buffer.byteLength(buffer, 'utf8'), error: err.message });
    }

    function onClose() {
      if (finished) return;
      finished = true;
      cleanup();
      return resolve({ raw: buffer.trim(), rtt_ms: Date.now() - start, bytes: Buffer.byteLength(buffer, 'utf8'), error: 'socket closed' });
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    // write command
    const cmd = command.endsWith('\n') ? command : command + '\n';
    try {
      socket.write(cmd, 'utf8', (err) => {
        if (err) {
          if (!finished) {
            finished = true;
            cleanup();
            return resolve({ raw: buffer.trim(), rtt_ms: Date.now() - start, bytes: Buffer.byteLength(buffer, 'utf8'), error: err.message });
          }
        }
      });
    } catch (e) {
      if (!finished) {
        finished = true;
        cleanup();
        return resolve({ raw: buffer.trim(), rtt_ms: Date.now() - start, bytes: Buffer.byteLength(buffer, 'utf8'), error: e.message });
      }
    }

    // per-command timer -> resolve with timeout:true (do not destroy socket)
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      return resolve({ raw: buffer.trim(), rtt_ms: null, bytes: Buffer.byteLength(buffer, 'utf8'), timeout: true });
    }, perCmdTimeoutMs);
  });
}

/* ---------- Routes: connect / send / close ---------- */

/**
 * Connect persistent tcpClient (used by measure & speedtest)
 * default port for SCPI socket is 5025
 */
router.post('/connect', (req, res) => {
  const { host = '192.168.0.1', port = 5025 } = req.body;

  if (tcpClient && !tcpClient.destroyed) {
    return res.status(400).json({ error: 'TCP already connected' });
  }

  tcpClient = new net.Socket();
  tcpClientInfo.host = host;
  tcpClientInfo.port = port;

  // global emitter to frontend logs
  tcpClient.on('connect', () => req.io.emit('tcp_open', { host, port }));
  tcpClient.on('data', (buf) => {
    // Emit raw data to frontend (useful for debugging)
    try {
      req.io.emit('tcp_rx', buf.toString('utf8'));
    } catch (e) {
      req.io.emit('tcp_rx', String(buf));
    }
  });
  tcpClient.on('error', (err) => req.io.emit('tcp_err', err.message));
  tcpClient.on('close', () => req.io.emit('tcp_close'));

  tcpClient.connect(port, host, () => {
    res.json({ ok: true, host, port });
  });
});

/**
 * Send arbitrary command. By default instrument commands are newline-terminated.
 * If command is a "set" that returns no reply (e.g. OUTPut ON), you can set expectResponse=false
 * to avoid waiting for a reply on the backend.
 *
 * Body:
 * { data: 'MEAS:VOLT?' , appendNewline: true, expectResponse: true, perCmdTimeoutMs: 3000 }
 */
router.post('/send', async (req, res) => {
  if (!tcpClient || tcpClient.destroyed) {
    return res.status(400).json({ error: 'TCP not connected' });
  }

  const { data = '', appendNewline = true, expectResponse = true, perCmdTimeoutMs = 3000 } = req.body;

  // if caller doesn't expect response -> fire-and-forget (many SCPI set commands behave like this)
  if (!expectResponse) {
    try {
      await writeRaw(tcpClient, data, appendNewline);
      req.io.emit('tcp_tx', data);
      return res.json({ ok: true, sent: data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // expect response -> send and wait for newline-terminated reply
  try {
    req.io.emit('tcp_tx', data);
    const r = await sendCommandOnceOnSocket(tcpClient, data, perCmdTimeoutMs);
    // r may indicate timeout or error
    return res.json({ ok: true, reply: r.raw ?? '', rtt_ms: r.rtt_ms ?? null, bytes: r.bytes ?? 0, timeout: !!r.timeout, error: r.error || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Close persistent connection
 */
router.post('/close', (req, res) => {
  if (!tcpClient || tcpClient.destroyed) {
    return res.json({ ok: true });
  }
  tcpClient.end(() => {
    tcpClient = null;
    tcpClientInfo = { host: null, port: null };
    return res.json({ ok: true });
  });
});

/* ---------- Convenience measure endpoints for BK 9801 ---------- */

/**
 * GET /tcp/measure/volt
 * Calls MEAS:VOLT? on the connected instrument and returns value + rtt
 */
router.get('/measure/volt', async (req, res) => {
  if (!tcpClient || tcpClient.destroyed) return res.status(400).json({ error: 'TCP not connected' });

  // Prevent concurrent command storms
  if (tcpBusy) return res.status(409).json({ error: 'Device busy' });

  tcpBusy = true;
  try {
    const r = await sendCommandOnceOnSocket(tcpClient, 'MEAS:VOLT?', 3000);
    tcpBusy = false;
    if (r.timeout) return res.status(504).json({ error: 'Timeout waiting for instrument reply' });
    const value = Number(r.raw);
    return res.json({ type: 'volt', raw: r.raw, value: Number.isFinite(value) ? value : r.raw, rtt_ms: r.rtt_ms, bytes: r.bytes || 0 });
  } catch (err) {
    tcpBusy = false;
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /tcp/measure/curr
 * Calls MEAS:CURR? on the connected instrument and returns value + rtt
 */
router.get('/measure/curr', async (req, res) => {
  if (!tcpClient || tcpClient.destroyed) return res.status(400).json({ error: 'TCP not connected' });

  if (tcpBusy) return res.status(409).json({ error: 'Device busy' });

  tcpBusy = true;
  try {
    const r = await sendCommandOnceOnSocket(tcpClient, 'MEAS:CURR?', 3000);
    tcpBusy = false;
    if (r.timeout) return res.status(504).json({ error: 'Timeout waiting for instrument reply' });
    const value = Number(r.raw);
    return res.json({ type: 'curr', raw: r.raw, value: Number.isFinite(value) ? value : r.raw, rtt_ms: r.rtt_ms, bytes: r.bytes || 0 });
  } catch (err) {
    tcpBusy = false;
    return res.status(500).json({ error: err.message });
  }
});

/* ---------- Speed test for SCPI instrument (safe approach) ---------- */

/**
 * POST /tcp/speedtest
 * Body:
 * {
 *   mode: 'rtt'|'throughput',   // default 'rtt'
 *   command: 'MEAS:VOLT?',      // default MEAS:VOLT?
 *   count: 20,                  // for rtt mode
 *   duration: 5,                // for throughput mode (seconds)
 *   minDelayMs: 10,             // delay between iterations (helps stability)
 *   perCmdTimeoutMs: 3000,
 *   maxConsecutiveTimeouts: 5
 * }
 */
router.post('/speedtest', async (req, res) => {
  if (!tcpClient || tcpClient.destroyed) return res.status(400).json({ error: 'TCP not connected' });

  if (tcpBusy) return res.status(409).json({ error: 'Device busy' });

  tcpBusy = true;
  const body = req.body || {};
  const mode = (body.mode || 'rtt').toString().toLowerCase();
  const command = body.command || 'MEAS:VOLT?';
  const minDelayMs = Number.isFinite(body.minDelayMs) ? Math.max(0, body.minDelayMs) : 10;
  const perCmdTimeoutMs = Number.isFinite(body.perCmdTimeoutMs) ? Math.max(100, body.perCmdTimeoutMs) : 3000;
  const maxConsecutiveTimeouts = Number.isFinite(body.maxConsecutiveTimeouts) ? Math.max(1, body.maxConsecutiveTimeouts) : 5;

  try {
    if (mode === 'rtt') {
      const count = Math.max(1, parseInt(body.count || 10, 10));
      const results = [];
      let consecutiveTimeouts = 0;

      for (let i = 0; i < count; ++i) {
        const r = await sendCommandOnceOnSocket(tcpClient, command, perCmdTimeoutMs);
        results.push({
          i: i + 1,
          raw: r.raw ?? '',
          rtt_ms: r.rtt_ms ?? null,
          bytes: r.bytes ?? 0,
          timeout: !!r.timeout,
          error: r.error || null
        });

        if (r.timeout) consecutiveTimeouts++; else consecutiveTimeouts = 0;
        if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
          results.push({ note: `Aborted after ${consecutiveTimeouts} consecutive timeouts.` });
          break;
        }

        if (minDelayMs > 0) await new Promise((s) => setTimeout(s, minDelayMs));
        else await new Promise((s) => setImmediate(s));
      }

      // compute stats
      const successes = results.filter(x => !x.timeout && typeof x.rtt_ms === 'number');
      const avg = successes.length ? successes.reduce((s, x) => s + x.rtt_ms, 0) / successes.length : null;
      const min = successes.length ? Math.min(...successes.map(x => x.rtt_ms)) : null;
      const max = successes.length ? Math.max(...successes.map(x => x.rtt_ms)) : null;
      const totalBytes = results.reduce((s, x) => s + (x.bytes || 0), 0);
      const opsPerSec = avg ? (1000 / avg) : null;

      tcpBusy = false;
      return res.json({
        mode: 'rtt',
        command, countRequested: count, minDelayMs,
        stats: { avg_ms: avg, min_ms: min, max_ms: max, ops_per_sec: opsPerSec, total_bytes: totalBytes },
        results
      });
    }

    if (mode === 'throughput') {
      const durationSec = Math.max(1, Number(body.duration || 5));
      let totalBytes = 0;
      let queries = 0;
      let consecutiveTimeouts = 0;
      const startTime = Date.now();
      const endAt = startTime + durationSec * 1000;

      while (Date.now() < endAt) {
        const r = await sendCommandOnceOnSocket(tcpClient, command, perCmdTimeoutMs);
        if (r.timeout) consecutiveTimeouts++; else consecutiveTimeouts = 0;

        totalBytes += r.bytes || 0;
        queries++;

        if (consecutiveTimeouts >= maxConsecutiveTimeouts) break;

        if (minDelayMs > 0) await new Promise((s) => setTimeout(s, minDelayMs));
        else await new Promise((s) => setImmediate(s));
      }

      // small grace
      await new Promise((s) => setTimeout(s, 120));

      const elapsedMs = Date.now() - startTime;
      const seconds = Math.max(0.001, elapsedMs / 1000);
      const megabytes = totalBytes / (1024 * 1024);
      const mb_per_s = megabytes / seconds;
      const ops_per_sec = queries / seconds;

      tcpBusy = false;
      return res.json({
        mode: 'throughput',
        command, durationRequestedSec: durationSec, durationMeasuredSec: seconds,
        minDelayMs, perCmdTimeoutMs, maxConsecutiveTimeouts,
        queriesSent: queries,
        total_bytes: totalBytes,
        megabytes,
        mb_per_s,
        ops_per_sec,
        note: 'Each iteration waits for the instrument response (safe for SCPI instruments).'
      });
    }

    tcpBusy = false;
    return res.status(400).json({ error: 'Invalid mode. Use "rtt" or "throughput".' });
  } catch (err) {
    tcpBusy = false;
    return res.status(500).json({ error: err.message });
  }
});

export default router;
