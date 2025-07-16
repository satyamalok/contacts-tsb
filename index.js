// index.js - Updated version

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const contactRoutes = require('./routes/contactRoutes');
const { updateDeviceLastSeen, markDeviceOffline } = require('./controllers/contactController');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT']
  }
});

// Device tracking for WebSocket connections
const connectedDevices = new Map();

// Make io accessible in other files
app.set('io', io);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/contacts', contactRoutes);

// Enhanced WebSocket connection handling
io.on('connection', (socket) => {
  console.log('🟢 New device connected via WebSocket: ' + socket.id);

  // Handle device registration
  socket.on('register-device', async (deviceInfo) => {
    const { device_id, device_name, device_type } = deviceInfo;
    
    // Store connection mapping
    connectedDevices.set(device_id, {
      socket_id: socket.id,
      device_name: device_name || 'Unknown',
      device_type: device_type || 'web',
      connected_at: new Date()
    });

    // Update device in database
    await updateDeviceLastSeen(device_id, deviceInfo);
    
    socket.device_id = device_id;
    console.log(`📱 Device registered: ${device_id} (${device_name})`);
    
    // Send confirmation
    socket.emit('registration-confirmed', {
      device_id,
      server_timestamp: new Date().toISOString()
    });
  });

  // Handle heartbeat to keep connection alive
  socket.on('heartbeat', async (data) => {
    if (socket.device_id) {
      await updateDeviceLastSeen(socket.device_id, data);
      socket.emit('heartbeat-ack', { timestamp: new Date().toISOString() });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('🔴 Device disconnected: ' + socket.id);
    
    if (socket.device_id) {
      connectedDevices.delete(socket.device_id);
      await markDeviceOffline(socket.device_id);
      console.log(`📱 Device marked offline: ${socket.device_id}`);
    }
  });
});

// Periodic cleanup of stale connections
setInterval(async () => {
  const now = new Date();
  for (const [deviceId, deviceInfo] of connectedDevices.entries()) {
    const timeDiff = now - deviceInfo.connected_at;
    // Mark as offline if no activity for 5 minutes
    if (timeDiff > 5 * 60 * 1000) {
      connectedDevices.delete(deviceId);
      await markDeviceOffline(deviceId);
      console.log(`🕐 Device timeout: ${deviceId}`);
    }
  }
}, 60000); // Check every minute

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});