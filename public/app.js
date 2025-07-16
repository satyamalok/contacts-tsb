// public/app.js - Updated version

const API_URL = '/contacts';

const tableBody = document.getElementById('contact-table-body');
const form = document.getElementById('contact-form');
const searchInput = document.getElementById('search');

let contacts = [];
let lastSyncTimestamp = localStorage.getItem('lastSyncTimestamp');
let deviceId = localStorage.getItem('deviceId') || 'web-' + Math.random().toString(36).substr(2, 9);
localStorage.setItem('deviceId', deviceId);

// Enhanced WebSocket connection
const socket = io();

// Register device on connection
socket.on('connect', () => {
  console.log('Connected to server');
  socket.emit('register-device', {
    device_id: deviceId,
    device_name: 'Web Browser',
    device_type: 'web'
  });
});

socket.on('registration-confirmed', (data) => {
  console.log('Device registered:', data);
  loadContacts(); // Load contacts after registration
});

// Heartbeat every 30 seconds
setInterval(() => {
  if (socket.connected) {
    socket.emit('heartbeat', {
      device_id: deviceId,
      timestamp: new Date().toISOString()
    });
  }
}, 30000);

// Enhanced real-time event handlers
socket.on('contact-created', (contact) => {
  console.log('Real-time: Contact created', contact);
  const existingIndex = contacts.findIndex(c => c.id === contact.id);
  if (existingIndex === -1) {
    contacts.unshift(contact);
    displayContacts(contacts);
  }
});

socket.on('contact-updated', (contact) => {
  console.log('Real-time: Contact updated', contact);
  const index = contacts.findIndex(c => c.id === contact.id);
  if (index !== -1) {
    contacts[index] = contact;
  } else {
    contacts.unshift(contact); // Add if not found (restored contact)
  }
  displayContacts(contacts);
});

socket.on('contact-deleted', (data) => {
  console.log('Real-time: Contact deleted', data);
  contacts = contacts.filter(c => c.id !== data.id);
  displayContacts(contacts);
});

// Enhanced contact loading with delta sync
async function loadContacts() {
  try {
    let url = `${API_URL}?device_id=${deviceId}`;
    
    // Use delta sync if we have a last sync timestamp
    if (lastSyncTimestamp) {
      url += `&since=${lastSyncTimestamp}`;
    }

    const res = await fetch(url);
    const data = await res.json();
    
    if (data.contacts) {
      if (lastSyncTimestamp) {
        // Delta sync - merge changes
        updateContactsFromDelta(data);
      } else {
        // Full sync
        contacts = data.contacts;
      }
    } else {
      // Fallback for old API response format
      contacts = data;
    }

    // Update last sync timestamp
    if (data.server_timestamp) {
      lastSyncTimestamp = data.server_timestamp;
      localStorage.setItem('lastSyncTimestamp', lastSyncTimestamp);
    }

    displayContacts(contacts);
    console.log(`Loaded ${contacts.length} contacts`);
  } catch (err) {
    console.error('Error loading contacts:', err);
  }
}

function updateContactsFromDelta(deltaData) {
  console.log('Processing delta sync:', deltaData);
  
  // Process new/updated contacts
  deltaData.contacts.forEach(newContact => {
    const existingIndex = contacts.findIndex(c => c.id === newContact.id);
    if (existingIndex !== -1) {
      contacts[existingIndex] = newContact;
    } else {
      contacts.unshift(newContact);
    }
  });

  // Process deleted contacts
  if (deltaData.deleted) {
    deltaData.deleted.forEach(deletedContact => {
      contacts = contacts.filter(c => c.id !== deletedContact.id);
    });
  }
}

function displayContacts(data) {
  tableBody.innerHTML = '';
  data.forEach(contact => {
    const row = document.createElement('tr');
    row.setAttribute('data-id', contact.id);
    row.innerHTML = `
      <td>${contact.client_name}</td>
      <td>${contact.agent_name || ''}</td>
      <td>${contact.phone1}</td>
      <td>${contact.phone2 || ''}</td>
      <td>${contact.phone3 || ''}</td>
      <td>${contact.state || ''}</td>
      <td>
        <button onclick="deleteContact('${contact.id}')">Delete</button>
      </td>
    `;
    tableBody.appendChild(row);
  });
}

// Enhanced form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const data = {
    client_name: form.client_name.value.trim(),
    agent_name: form.agent_name.value.trim(),
    phone1: form.phone1.value.trim(),
    phone2: form.phone2.value.trim(),
    phone3: form.phone3.value.trim(),
    state: form.state.value.trim(),
    date: new Date().toISOString().split('T')[0],
    device_id: deviceId
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      form.reset();
      // Real-time updates will handle UI update
    } else {
      const error = await res.json();
      alert(error.error || 'Failed to add contact');
    }
  } catch (err) {
    console.error('Error adding contact:', err);
  }
});

// Enhanced delete function
async function deleteContact(id) {
  if (!confirm('Are you sure you want to delete this contact?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, { 
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId })
    });
    
    if (!res.ok) {
      alert('Failed to delete contact');
    }
    // Real-time updates will handle UI update
  } catch (err) {
    console.error('Error deleting contact:', err);
  }
}

// Enhanced search
searchInput.addEventListener('input', () => {
  const value = searchInput.value.toLowerCase();
  const filtered = contacts.filter(c =>
    c.client_name.toLowerCase().includes(value) ||
    c.phone1.includes(value) ||
    (c.agent_name && c.agent_name.toLowerCase().includes(value))
  );
  displayContacts(filtered);
});

// Load contacts on page load (will be called after device registration)
// loadContacts(); // Removed from here, now called after registration