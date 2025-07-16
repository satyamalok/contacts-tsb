const express = require('express');
const router = express.Router();
const contactController = require('../controllers/contactController');

// Get all contacts (with optional delta sync)
router.get('/', contactController.getContacts);

// Delta sync endpoint
router.get('/sync/delta/:device_id', contactController.getDeltaSync);

// Message acknowledgment
router.post('/ack', contactController.acknowledgeMessage);

// Handle device reconnection
router.post('/sync/reconnect', contactController.handleReconnection);

// Check duplicate by phone number
router.get('/phone/:number', contactController.checkDuplicate);

// Device management
router.get('/devices', contactController.getDevices);

// Create new contact
router.post('/', contactController.createContact);

// Batch sync
router.post('/sync', contactController.syncContacts);

// Update contact
router.put('/:id', contactController.updateContact);

// Delete contact (soft delete)
router.delete('/:id', contactController.deleteContact);

module.exports = router;