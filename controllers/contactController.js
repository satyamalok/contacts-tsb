// controllers/contactController.js - Updated version

const pool = require('../db');
const { v4: uuidv4 } = require('uuid');

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

// GET /contacts/sync/delta/:device_id - New delta sync endpoint
exports.getDeltaSync = async (req, res) => {
  const { device_id } = req.params;
  const { since } = req.query;

  try {
    // Update device last seen
    await updateDeviceLastSeen(device_id);

    // Get device's last sync timestamp if 'since' not provided
    let sinceTimestamp = since;
    if (!sinceTimestamp) {
      const deviceResult = await pool.query(
        'SELECT last_sync_timestamp FROM devices WHERE id = $1',
        [device_id]
      );
      sinceTimestamp = deviceResult.rows[0]?.last_sync_timestamp || '1970-01-01';
    }

    // Get modified contacts
    const contactsResult = await pool.query(
      `SELECT * FROM contacts 
       WHERE last_modified > $1 
       ORDER BY last_modified ASC`,
      [sinceTimestamp]
    );

    // Get deleted contacts
    const deletedResult = await pool.query(
      `SELECT id, deleted, last_modified FROM contacts 
       WHERE deleted = true AND last_modified > $1`,
      [sinceTimestamp]
    );

    // Update device's last sync timestamp
    await pool.query(
      'UPDATE devices SET last_sync_timestamp = NOW() WHERE id = $1',
      [device_id]
    );

    res.json({
      contacts: contactsResult.rows.filter(c => !c.deleted),
      deleted: deletedResult.rows,
      server_timestamp: new Date().toISOString(),
      since: sinceTimestamp
    });
  } catch (error) {
    console.error('Error in delta sync:', error);
    res.status(500).json({ error: 'Failed to perform delta sync' });
  }
};

// POST /contacts - Enhanced with better timestamp handling
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
        
        // Emit real-time update
        const io = req.app.get('io');
        io.emit('contact-updated', {
          ...updated.rows[0],
          event_type: 'restored'
        });

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

    // Emit real-time update
    const io = req.app.get('io');
    io.emit('contact-created', {
      ...result.rows[0],
      event_type: 'created'
    });

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
};

// PUT /contacts/:id - Enhanced with timestamp handling
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

    // Emit real-time update
    const io = req.app.get('io');
    io.emit('contact-updated', {
      ...result.rows[0],
      event_type: 'updated'
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

// DELETE /contacts/:id - Enhanced with timestamp handling
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

    // Emit real-time update
    const io = req.app.get('io');
    io.emit('contact-deleted', { 
      id,
      event_type: 'deleted',
      timestamp: new Date().toISOString()
    });

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
      'SELECT * FROM devices ORDER BY last_seen DESC'
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

// Export all controller functions
module.exports.getContacts = exports.getContacts;
module.exports.checkDuplicate = exports.checkDuplicate;
module.exports.createContact = exports.createContact;
module.exports.updateContact = exports.updateContact;
module.exports.deleteContact = exports.deleteContact;
module.exports.syncContacts = exports.syncContacts;
module.exports.getDeltaSync = exports.getDeltaSync;
module.exports.getDevices = exports.getDevices;