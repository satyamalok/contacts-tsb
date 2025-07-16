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
  },
  pingTimeout: 60000,      // 60 seconds
  pingInterval: 25000,     // 25 seconds - frequent heartbeat
  transports: ['websocket', 'polling']
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
      socket: socket,
      device_name: device_name || 'Unknown',
      device_type: device_type || 'web',
      connected_at: new Date(),
      last_ping: new Date()
    });

    // Update device in database
    await updateDeviceLastSeen(device_id, deviceInfo);
    
    socket.device_id = device_id;
    console.log(`📱 Device registered: ${device_id} (${device_name})`);
    
    // Send confirmation with current server time
    socket.emit('registration-confirmed', {
      device_id,
      server_timestamp: new Date().toISOString(),
      connection_id: socket.id
    });

    // Send any queued messages for this device
    await sendQueuedMessages(device_id, socket);
  });

  // Enhanced heartbeat with connection health check
  socket.on('heartbeat', async (data) => {
    if (socket.device_id) {
      const deviceInfo = connectedDevices.get(socket.device_id);
      if (deviceInfo) {
        deviceInfo.last_ping = new Date();
        connectedDevices.set(socket.device_id, deviceInfo);
      }
      
      await updateDeviceLastSeen(socket.device_id, data);
      socket.emit('heartbeat-ack', { 
        timestamp: new Date().toISOString(),
        server_status: 'healthy'
      });
    }
  });

  // Handle device requesting full sync after reconnection
  socket.on('request-full-sync', async (data) => {
    if (socket.device_id) {
      console.log(`🔄 Full sync requested by: ${socket.device_id}`);
      
      // Clear any stored sync timestamp for this device to force full sync
      socket.emit('force-full-sync', {
        clear_local_storage: true,
        reason: 'reconnection_sync'
      });
    }
  });

  // Handle message acknowledgment
  socket.on('message-ack', async (data) => {
    const { message_uuids } = data;
    if (socket.device_id && message_uuids) {
      await acknowledgeMessages(socket.device_id, message_uuids);
    }
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.log('🔴 Socket error:', error);
  });

  // Handle disconnection
  socket.on('disconnect', async (reason) => {
    console.log(`🔴 Device disconnected: ${socket.id}, reason: ${reason}`);
    
    if (socket.device_id) {
      connectedDevices.delete(socket.device_id);
      await markDeviceOffline(socket.device_id);
      console.log(`📱 Device marked offline: ${socket.device_id}`);
    }
  });
});

// Function to send queued messages to a reconnected device
async function sendQueuedMessages(deviceId, socket) {
  try {
    const pool = require('./db');
    const queuedMessages = await pool.query(
      `SELECT id, event_type, event_data, message_uuid, created_at 
       FROM message_queue
       WHERE device_id = $1 AND delivered = false
       ORDER BY created_at ASC
       LIMIT 50`,
      [deviceId]
    );

    if (queuedMessages.rows.length > 0) {
      console.log(`📨 Sending ${queuedMessages.rows.length} queued messages to ${deviceId}`);
      
      for (const message of queuedMessages.rows) {
        socket.emit('queued-message', {
          id: message.id,
          type: message.event_type,
          data: JSON.parse(message.event_data),
          message_uuid: message.message_uuid,
          timestamp: message.created_at,
          requires_ack: true
        });
      }

      socket.emit('queued-messages-complete', {
        total_sent: queuedMessages.rows.length
      });
    }
  } catch (error) {
    console.error('Error sending queued messages:', error);
  }
}

// Function to acknowledge messages
async function acknowledgeMessages(deviceId, messageUuids) {
  try {
    const pool = require('./db');
    const result = await pool.query(
      `UPDATE message_queue SET delivered = true 
       WHERE device_id = $1 AND message_uuid = ANY($2::uuid[])
       RETURNING id`,
      [deviceId, messageUuids]
    );

    console.log(`✅ Acknowledged ${result.rows.length} messages for ${deviceId}`);
  } catch (error) {
    console.error('Error acknowledging messages:', error);
  }
}

// Periodic cleanup and health check
setInterval(async () => {
  const now = new Date();
  const staleConnections = [];

  // Check for stale connections
  for (const [deviceId, deviceInfo] of connectedDevices.entries()) {
    const timeSinceLastPing = now - deviceInfo.last_ping;
    
    // Mark as stale if no ping for 2 minutes
    if (timeSinceLastPing > 2 * 60 * 1000) {
      staleConnections.push(deviceId);
    }
  }

  // Clean up stale connections
  for (const deviceId of staleConnections) {
    console.log(`🕐 Cleaning up stale connection: ${deviceId}`);
    connectedDevices.delete(deviceId);
    await markDeviceOffline(deviceId);
  }

  // Log connection status
  console.log(`💻 Active connections: ${connectedDevices.size}`);
}, 60000); // Check every minute

// Broadcast function for other modules
global.broadcastToDevice = (deviceId, eventType, data) => {
  const deviceInfo = connectedDevices.get(deviceId);
  if (deviceInfo && deviceInfo.socket) {
    deviceInfo.socket.emit(eventType, data);
    return true;
  }
  return false;
};

// Export io for controller usage
module.exports = { io };

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});