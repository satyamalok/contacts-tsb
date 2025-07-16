const pool = require('../db');
const { v4: uuidv4 } = require('uuid');

// GET /contacts
exports.getContacts = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE deleted = false ORDER BY updated_at DESC'
    );
    res.json(result.rows);
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

// POST /contacts
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
    const existing = await pool.query('SELECT * FROM contacts WHERE phone1 = $1', [phone1]);

if (existing.rows.length > 0) {
  const contact = existing.rows[0];

  if (contact.deleted) {
    // "Undelete" and update
    const updated = await pool.query(
      `UPDATE contacts
       SET deleted = false, client_name = $1, agent_name = $2, phone2 = $3, phone3 = $4,
           state = $5, date = $6, device_id = $7, updated_at = NOW(), version = version + 1
       WHERE id = $8 RETURNING *`,
      [client_name, agent_name, phone2, phone3, state, date, device_id, contact.id]
    );
    return res.status(201).json(updated.rows[0]);
  } else {
    return res.status(400).json({ error: 'Phone number already exists' });
  }
}

    const id = uuidv4();
    const result = await pool.query(
      `INSERT INTO contacts (id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id]
    );

    // 🔁 Emit contact-added event
    const io = req.app.get('io');
    io.emit('contact-added', result.rows[0]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
};

// PUT /contacts/:id
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
    const result = await pool.query(
      `UPDATE contacts
       SET client_name=$1, agent_name=$2, phone1=$3, phone2=$4, phone3=$5,
           state=$6, date=$7, device_id=$8, updated_at=NOW(), version = version + 1
       WHERE id=$9 AND deleted = false
       RETURNING *`,
      [client_name, agent_name, phone1, phone2, phone3, state, date, device_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // 🔁 Emit contact-updated event
    const io = req.app.get('io');
    io.emit('contact-updated', result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

// DELETE /contacts/:id
exports.deleteContact = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE contacts SET deleted = true, updated_at = NOW(), version = version + 1 WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // 🔁 Emit contact-deleted event
    const io = req.app.get('io');
    io.emit('contact-deleted', { id });

    res.json({ success: true, deleted: result.rows[0] });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};
// POST /sync
exports.syncContacts = async (req, res) => {
  const { device_id, contacts } = req.body;

  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: 'Invalid contacts array' });
  }

  const results = [];

  try {
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
        deleted
      } = contact;

      const existing = await pool.query('SELECT * FROM contacts WHERE id = $1', [id]);

      if (existing.rows.length === 0) {
        // New contact → insert
        const result = await pool.query(
          `INSERT INTO contacts
          (id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id, version, deleted)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING *`,
          [id, client_name, agent_name, phone1, phone2, phone3, state, date, device_id, version, deleted || false]
        );
        results.push(result.rows[0]);
      } else {
        const existingContact = existing.rows[0];

        if (version > existingContact.version) {
          // Update if incoming version is newer
          const updated = await pool.query(
            `UPDATE contacts
             SET client_name=$1, agent_name=$2, phone1=$3, phone2=$4, phone3=$5,
                 state=$6, date=$7, device_id=$8, version=$9, updated_at=NOW(), deleted=$10
             WHERE id=$11
             RETURNING *`,
            [client_name, agent_name, phone1, phone2, phone3, state, date, device_id, version, deleted || false, id]
          );
          results.push(updated.rows[0]);
        } else {
          // Server version is newer → keep it
          results.push(existingContact);
        }
      }
    }

    res.json({ synced: results });
  } catch (error) {
    console.error('Error syncing contacts:', error);
    res.status(500).json({ error: 'Failed to sync contacts' });
  }
};

