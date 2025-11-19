// server/server.js
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

// IMPORT ROUTES
import serialRoutes from './routes/serialRoutes.js';
import ethernetRoutes from './routes/ethernetRoutes.js';

const app = express();
app.use(express.json());
app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:5173'] }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: ['http://localhost:3000', 'http://localhost:5173'] }
});

// Attach io to request so routes can emit events
app.use((req, res, next) => {
  req.io = io;
  next();
});

// USE ROUTES
app.use('/serial', serialRoutes);
app.use('/tcp', ethernetRoutes);

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
