const express = require('express');
const router = express.Router();
const contactController = require('../controllers/contactController');

// Get all contacts
router.get('/', contactController.getContacts);

// Check duplicate by phone number
router.get('/phone/:number', contactController.checkDuplicate);

// Create new contact
router.post('/', contactController.createContact);

router.post('/sync', contactController.syncContacts);

// Update contact
router.put('/:id', contactController.updateContact);

// Delete contact (soft delete)
router.delete('/:id', contactController.deleteContact);

module.exports = router;
