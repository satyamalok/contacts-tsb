// controllers/contactController.js - Phase 2 Enhanced

const pool = require('../db');
const { v4: uuidv4 } = require('uuid');

// Message queue functions
const queueMessageForDevice = async (deviceId, eventType, eventData) => {
  try {
    const result = await pool.query(
      `INSERT INTO message_queue (device_id, event_type, event_data, message_uuid)
       VALUES ($1, $2, $3, $4) RETURNING id, message_uuid`,
      [deviceId, eventType, JSON.stringify(eventData), uuidv4()]
    );
    
    // Update pending message count
    await pool.query(
      `INSERT INTO device_sync_status (device_id, pending_messages)
       VALUES ($1, 1)
       ON CONFLICT (device_id)
       DO UPDATE SET pending_messages = device_sync_status.pending_messages + 1`,
      [deviceId]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('Error queuing message:', error);
  }
};

const getConnectedDevices = (io) => {
  if (!io || !io.sockets) {
    return [];
  }
  
  const connectedSockets = io.sockets.sockets;
  const connectedDeviceIds = [];
  
  connectedSockets.forEach((socket) => {
    if (socket.device_id) {
      connectedDeviceIds.push(socket.device_id);
    }
  });
  
  return connectedDeviceIds;
};

const broadcastToOnlineDevices = async (eventType, eventData, excludeDeviceId = null, io = null) => {
  try {
    if (!io) {
      console.log('No io instance available for broadcasting');
      return;
    }
    
    const connectedDevices = getConnectedDevices(io);
    const allDevicesResult = await pool.query('SELECT id FROM devices');
    const allDevices = allDevicesResult.rows.map(row => row.id);
    
    for (const deviceId of allDevices) {
      if (deviceId === excludeDeviceId) continue;
      
      if (connectedDevices.includes(deviceId)) {
        // Device is online - send directly with GENERIC event names
        io.emit(eventType, eventData);  // ✅ Use generic event names
      } else {
        // Device is offline - queue the message
        await queueMessageForDevice(deviceId, eventType, eventData);
      }
    }
  } catch (error) {
    console.error('Error broadcasting to devices:', error);
  }
};

// Device management functions
const updateDeviceLastSeen = async (deviceId, deviceInfo = {}) => {
  try {
    await pool.query(
      `INSERT INTO devices (id, device_name, device_type, last_seen) 
       VALUES ($1, $2, $3, NOW()) 
       ON CONFLICT (id) 
       DO UPDATE SET last_seen = NOW(), status = 'online'`,
      [deviceId, deviceInfo.name || 'Unknown', deviceInfo.type || 'web']
    );
    
    // Update sync status
    await pool.query(
      `INSERT INTO device_sync_status (device_id, last_online)
       VALUES ($1, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET last_online = NOW()`,
      [deviceId]
    );
  } catch (error) {
    console.error('Error updating device last seen:', error);
  }
};

const markDeviceOffline = async (deviceId) => {
  try {
    await pool.query(
      `UPDATE devices SET status = 'offline' WHERE id = $1`,
      [deviceId]
    );
  } catch (error) {
    console.error('Error marking device offline:', error);
  }
};

// GET /contacts - Enhanced with timestamp filtering
exports.getContacts = async (req, res) => {
  const { device_id, since } = req.query;
  
  try {
    // Update device last seen
    if (device_id) {
      await updateDeviceLastSeen(device_id, { 
        name: req.headers['user-agent'], 
        type: 'web' 
      });
    }

    let query;
    let params = [];

    if (since) {
      // Delta sync - only return contacts modified since timestamp
      query = `SELECT * FROM contacts 
               WHERE deleted = false AND last_modified > $1 
               ORDER BY last_modified ASC`;
      params = [since];
    } else {
      // Full sync
      query = `SELECT * FROM contacts 
               WHERE deleted = false 
               ORDER BY last_modified DESC`;
    }

    const result = await pool.query(query, params);
    
    // Also return deleted contacts for delta sync
    if (since) {
      const deletedResult = await pool.query(
        `SELECT id, deleted, last_modified FROM contacts 
         WHERE deleted = true AND last_modified > $1`,
        [since]
      );
      
      return res.json({
        contacts: result.rows,
        deleted: deletedResult.rows,
        server_timestamp: new Date().toISOString()
      });
    }

    res.json({
      contacts: result.rows,
      server_timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

// GET /contacts/phone/:number
exports.checkDuplicate = async (req, res) => {
  const { number } = req.params;
  try {
    const result = await pool.query('SELECT * FROM contacts WHERE phone1 = $1', [number]);
    if (result.rows.length > 0) {
      res.json({ exists: true, contact: result.rows[0] });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    console.error('Error checking duplicate:', error);
    res.status(500).json({ error: 'Failed to check duplicate' });
  }
};

// GET /contacts/sync/delta/:device_id - Enhanced delta sync
exports.getDeltaSync = async (req, res) => {
  const { device_id } = req.params;
  const { since, batch_size = 100 } = req.query;

  try {
    // Update device last seen
    await updateDeviceLastSeen(device_id);

    // Mark sync in progress
    await pool.query(
      `UPDATE device_sync_status SET sync_in_progress = true WHERE device_id = $1`,
      [device_id]
    );

    // Get device's last sync timestamp if 'since' not provided
    let sinceTimestamp = since;
    if (!sinceTimestamp) {
      const deviceResult = await pool.query(
        'SELECT last_sync_timestamp FROM devices WHERE id = $1',
        [device_id]
      );
      sinceTimestamp = deviceResult.rows[0]?.last_sync_timestamp || '1970-01-01';
    }

    // Get modified contacts with pagination
    const contactsResult = await pool.query(
      `SELECT * FROM contacts 
       WHERE last_modified > $1 
       ORDER BY last_modified ASC
       LIMIT $2`,
      [sinceTimestamp, batch_size]
    );

    // Get deleted contacts
    const deletedResult = await pool.query(
      `SELECT id, deleted, last_modified FROM contacts 
       WHERE deleted = true AND last_modified > $1
       LIMIT $2`,
      [sinceTimestamp, batch_size]
    );

    // Get queued messages for this device
    const queuedMessages = await pool.query(
      `SELECT id, event_type, event_data, message_uuid, created_at FROM message_queue
       WHERE device_id = $1 AND delivered = false
       ORDER BY created_at ASC
       LIMIT $2`,
      [device_id, batch_size]
    );

    // Update device's last sync timestamp
    await pool.query(
      'UPDATE devices SET last_sync_timestamp = NOW() WHERE id = $1',
      [device_id]
    );

    // Mark sync completed
    await pool.query(
      `UPDATE device_sync_status SET sync_in_progress = false WHERE device_id = $1`,
      [device_id]
    );

    res.json({
      contacts: contactsResult.rows.filter(c => !c.deleted),
      deleted: deletedResult.rows,
      queued_messages: queuedMessages.rows,
      server_timestamp: new Date().toISOString(),
      since: sinceTimestamp,
      has_more: contactsResult.rows.length === parseInt(batch_size)
    });
  } catch (error) {
    console.error('Error in delta sync:', error);
    res.status(500).json({ error: 'Failed to perform delta sync' });
  }
};

// POST /contacts/ack - Message acknowledgment endpoint
exports.acknowledgeMessage = async (req, res) => {
  const { device_id, message_uuids } = req.body;

  try {
    if (!Array.isArray(message_uuids)) {
      return res.status(400).json({ error: 'message_uuids must be an array' });
    }

    // Mark messages as delivered
    const result = await pool.query(
      `UPDATE message_queue SET delivered = true 
       WHERE device_id = $1 AND message_uuid = ANY($2::uuid[])
       RETURNING id`,
      [device_id, message_uuids]
    );

    // Update pending message count
    await pool.query(
      `UPDATE device_sync_status 
       SET pending_messages = GREATEST(0, pending_messages - $1)
       WHERE device_id = $2`,
      [result.rows.length, device_id]
    );

    res.json({ acknowledged: result.rows.length });
  } catch (error) {
    console.error('Error acknowledging messages:', error);
    res.status(500).json({ error: 'Failed to acknowledge messages' });
  }
};

// POST /contacts/sync/reconnect - Handle device reconnection
exports.handleReconnection = async (req, res) => {
  const { device_id, last_seen_timestamp } = req.body;

  try {
    // Update device status
    await updateDeviceLastSeen(device_id);

    // Get pending message count
    const syncStatus = await pool.query(
      'SELECT pending_messages FROM device_sync_status WHERE device_id = $1',
      [device_id]
    );

    const pendingCount = syncStatus.rows[0]?.pending_messages || 0;

    // Get recent changes since last seen
    const recentChanges = await pool.query(
      `SELECT COUNT(*) as change_count FROM contacts
       WHERE last_modified > $1`,
      [last_seen_timestamp || '1970-01-01']
    );

    res.json({
      status: 'reconnected',
      pending_messages: pendingCount,
      recent_changes: parseInt(recentChanges.rows[0].change_count),
      requires_full_sync: pendingCount > 50 || recentChanges.rows[0].change_count > 100
    });
  } catch (error) {
    console.error('Error handling reconnection:', error);
    res.status(500).json({ error: 'Failed to handle reconnection' });
  }
};

// POST /contacts - Enhanced with offline queue
exports.createContact = async (req, res) => {
  const {
    client_name,
    agent_name,
    phone1,
    phone2,
    phone3,
    state,
    date,
    device_id
  } = req.body;

  try {
    // Update device last seen
    if (device_id) {
      await updateDeviceLastSeen(device_id);
    }

    const existing = await pool.query('SELECT * FROM contacts WHERE phone1 = $1', [phone1]);

    if (existing.rows.length > 0) {
      const contact = existing.rows[0];

      if (contact.deleted) {
        // "Undelete" and update
        const updated = await pool.query(
          `UPDATE contacts
           SET deleted = false, client_name = $1, agent_name = $2, phone2 = $3, phone3 = $4,
               state = $5, date = $6, device_id = $7, last_modified = NOW(), version = version + 1
           WHERE id = $8 RETURNING *`,
          [client_name, agent_name, phone2, phone3, state, date, device_id, contact.id]
        );
        
        // Broadcast to all devices with offline queue
        const io = req.app.get('io');
await broadcastToOnlineDevices('contact-updated', {
  ...updated.rows[0],
  event_type: 'restored'
}, device_id, io);

        return res.status(201).json(updated.rows[0]);
      } else {
        return res.status(400).json({ error: 'Phone number already exists' });
      }
    }

    const id = uuidv4();
    const result = await pool.query(
      `INSERT INTO contacts (id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id, created_at, last_modified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id]
    );

    // Broadcast to all devices with offline queue
    const io = req.app.get('io');
await broadcastToOnlineDevices('contact-created', {
  ...result.rows[0],
  event_type: 'created'
}, device_id, io);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
};

// PUT /contacts/:id - Enhanced with offline queue
exports.updateContact = async (req, res) => {
  const { id } = req.params;
  const {
    client_name,
    agent_name,
    phone1,
    phone2,
    phone3,
    state,
    date,
    device_id
  } = req.body;

  try {
    // Update device last seen
    if (device_id) {
      await updateDeviceLastSeen(device_id);
    }

    const result = await pool.query(
      `UPDATE contacts
       SET client_name=$1, agent_name=$2, phone1=$3, phone2=$4, phone3=$5,
           state=$6, date=$7, device_id=$8, last_modified=NOW(), version = version + 1
       WHERE id=$9 AND deleted = false
       RETURNING *`,
      [client_name, agent_name, phone1, phone2, phone3, state, date, device_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Broadcast to all devices with offline queue
    const io = req.app.get('io');
await broadcastToOnlineDevices('contact-updated', {
  ...result.rows[0],
  event_type: 'updated'
}, device_id, io);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

// DELETE /contacts/:id - Enhanced with offline queue
exports.deleteContact = async (req, res) => {
  const { id } = req.params;
  const { device_id } = req.body;

  try {
    // Update device last seen
    if (device_id) {
      await updateDeviceLastSeen(device_id);
    }

    const result = await pool.query(
      `UPDATE contacts SET deleted = true, last_modified = NOW(), version = version + 1 WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Broadcast to all devices with offline queue
    const io = req.app.get('io');
await broadcastToOnlineDevices('contact-deleted', { 
  id,
  event_type: 'deleted',
  timestamp: new Date().toISOString()
}, device_id, io);

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

// Enhanced sync with better conflict resolution
exports.syncContacts = async (req, res) => {
  const { device_id, contacts, last_sync } = req.body;

  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: 'Invalid contacts array' });
  }

  try {
    // Update device last seen
    await updateDeviceLastSeen(device_id);

    const results = [];
    const conflicts = [];

    for (const contact of contacts) {
      const {
        id,
        client_name,
        agent_name,
        phone1,
        phone2,
        phone3,
        state,
        date,
        version,
        deleted,
        last_modified
      } = contact;

      const existing = await pool.query('SELECT * FROM contacts WHERE id = $1', [id]);

      if (existing.rows.length === 0) {
        // New contact → insert
        const result = await pool.query(
          `INSERT INTO contacts
          (id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id, version, deleted, created_at, last_modified)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
          RETURNING *`,
          [id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id, version, deleted || false]
        );
        results.push(result.rows[0]);
      } else {
        const existingContact = existing.rows[0];
        const serverModified = new Date(existingContact.last_modified);
        const clientModified = new Date(last_modified);

        if (clientModified > serverModified) {
          // Client version is newer
          const updated = await pool.query(
            `UPDATE contacts
             SET client_name=$1, agent_name=$2, phone1=$3, phone2=$4, phone3=$5,
                 state=$6, date=$7, device_id=$8, version=$9, last_modified=$10, deleted=$11
             WHERE id=$12
             RETURNING *`,
            [client_name, agent_name, phone1, phone2, phone3, state, date, device_id, version, last_modified, deleted || false, id]
          );
          results.push(updated.rows[0]);
        } else if (serverModified > clientModified) {
          // Server version is newer → send back server version
          results.push(existingContact);
        } else {
          // Same timestamp but different content → conflict
          if (JSON.stringify(existingContact) !== JSON.stringify(contact)) {
            conflicts.push({
              id,
              server_version: existingContact,
              client_version: contact
            });
          }
          results.push(existingContact);
        }
      }
    }

    // Update device's last sync timestamp
    await pool.query(
      'UPDATE devices SET last_sync_timestamp = NOW() WHERE id = $1',
      [device_id]
    );

    res.json({ 
      synced: results,
      conflicts: conflicts,
      server_timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error syncing contacts:', error);
    res.status(500).json({ error: 'Failed to sync contacts' });
  }
};

// GET /devices - Get device status
exports.getDevices = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, ds.pending_messages, ds.last_online, ds.sync_in_progress
       FROM devices d
       LEFT JOIN device_sync_status ds ON d.id = ds.device_id
       ORDER BY d.last_seen DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
};

// Export utility functions for WebSocket usage
module.exports.updateDeviceLastSeen = updateDeviceLastSeen;
module.exports.markDeviceOffline = markDeviceOffline;
module.exports.queueMessageForDevice = queueMessageForDevice;
module.exports.broadcastToOnlineDevices = broadcastToOnlineDevices;