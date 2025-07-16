const express = require('express');
const router = express.Router();
const contactController = require('../controllers/contactController');

// Debug: Check what functions are available
console.log('Available controller functions:', Object.keys(contactController));
console.log('getDeltaSync type:', typeof contactController.getDeltaSync);
console.log('getDevices type:', typeof contactController.getDevices);
console.log('checkDuplicate type:', typeof contactController.checkDuplicate);

// Get all contacts (with optional delta sync)
router.get('/', contactController.getContacts);

// THIS IS LINE 14 - Check if this function exists
console.log('About to register getDeltaSync route...');
if (typeof contactController.getDeltaSync === 'function') {
    router.get('/sync/delta/:device_id', contactController.getDeltaSync);
    console.log('getDeltaSync route registered successfully');
} else {
    console.log('ERROR: getDeltaSync is not a function!');
}

// Check duplicate by phone number
router.get('/phone/:number', contactController.checkDuplicate);

// Device management
if (typeof contactController.getDevices === 'function') {
    router.get('/devices', contactController.getDevices);
} else {
    console.log('ERROR: getDevices is not a function!');
}

// Create new contact
router.post('/', contactController.createContact);

// Batch sync
router.post('/sync', contactController.syncContacts);

// Update contact
router.put('/:id', contactController.updateContact);

// Delete contact (soft delete)
router.delete('/:id', contactController.deleteContact);

module.exports = router;