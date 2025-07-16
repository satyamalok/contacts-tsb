require('dotenv').config(); // Load .env variables

const express = require('express');
const cors = require('cors');
const http = require('http'); // ✅ required for WebSocket
const { Server } = require('socket.io');

const contactRoutes = require('./routes/contactRoutes');

const app = express();
const server = http.createServer(app); // ✅ shared server
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT']
  }
});

// ✅ Make io accessible in other files (we'll use it in controllers)
app.set('io', io);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/contacts', contactRoutes);

// ✅ Log new WebSocket connections
io.on('connection', (socket) => {
  console.log('🟢 New device connected via WebSocket: ' + socket.id);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

