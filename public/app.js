const API_URL = '/contacts';

const tableBody = document.getElementById('contact-table-body');
const form = document.getElementById('contact-form');
const searchInput = document.getElementById('search');

let contacts = [];
let deviceId = localStorage.getItem('deviceId') || 'web-' + Math.random().toString(36).substr(2, 9);
localStorage.setItem('deviceId', deviceId);

let socket;
let reconnectAttempts = 0;
let maxReconnectAttempts = 10;
let isConnected = false;
let heartbeatInterval;

// Connection status indicator
function updateConnectionStatus(status) {
  const indicator = document.getElementById('connection-status') || createConnectionIndicator();
  indicator.textContent = status;
  indicator.className = `connection-status ${status.toLowerCase().replace(' ', '-')}`;
}

function createConnectionIndicator() {
  const indicator = document.createElement('div');
  indicator.id = 'connection-status';
  indicator.style.cssText = `
    position: fixed; top: 10px; right: 10px; padding: 8px 12px;
    border-radius: 4px; font-size: 12px; z-index: 1000;
  `;
  document.body.appendChild(indicator);
  return indicator;
}

// Enhanced WebSocket connection with auto-reconnect
function connectWebSocket() {
  updateConnectionStatus('Connecting...');
  
  socket = io({
    transports: ['websocket', 'polling'],
    timeout: 5000,
    reconnection: true,
    reconnectionAttempts: maxReconnectAttempts,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  });

  socket.on('connect', () => {
    console.log('🟢 Connected to server');
    isConnected = true;
    reconnectAttempts = 0;
    updateConnectionStatus('Connected');
    
    // Register device
    socket.emit('register-device', {
      device_id: deviceId,
      device_name: 'Web Browser',
      device_type: 'web',
      user_agent: navigator.userAgent
    });
  });

  socket.on('registration-confirmed', (data) => {
    console.log('✅ Device registered:', data);
    updateConnectionStatus('Online');
    
    // Start heartbeat
    startHeartbeat();
    
    // Load contacts after successful registration
    loadContacts(true); // Force full sync on reconnection
  });

  socket.on('force-full-sync', (data) => {
    console.log('🔄 Server requested full sync:', data.reason);
    if (data.clear_local_storage) {
      localStorage.removeItem('lastSyncTimestamp');
    }
    loadContacts(true);
  });

  socket.on('heartbeat-ack', (data) => {
    console.log('💓 Heartbeat acknowledged');
  });

  // Enhanced real-time event handlers
  socket.on('contact-created', (contact) => {
    console.log('📱 Real-time: Contact created', contact);
    const existingIndex = contacts.findIndex(c => c.id === contact.id);
    if (existingIndex === -1) {
      contacts.unshift(contact);
      displayContacts(contacts);
    }
  });

  socket.on('contact-updated', (contact) => {
    console.log('📱 Real-time: Contact updated', contact);
    const index = contacts.findIndex(c => c.id === contact.id);
    if (index !== -1) {
      contacts[index] = contact;
    } else {
      contacts.unshift(contact);
    }
    displayContacts(contacts);
  });

  socket.on('contact-deleted', (data) => {
    console.log('📱 Real-time: Contact deleted', data);
    contacts = contacts.filter(c => c.id !== data.id);
    displayContacts(contacts);
  });

  // Handle queued messages from when device was offline
  socket.on('queued-message', (message) => {
    console.log('📨 Received queued message:', message);
    processQueuedMessage(message);
    
    // Acknowledge the message
    socket.emit('message-ack', {
      message_uuids: [message.message_uuid]
    });
  });

  socket.on('queued-messages-complete', (data) => {
    console.log(`📨 Received all ${data.total_sent} queued messages`);
    displayContacts(contacts);
  });

  socket.on('disconnect', (reason) => {
    console.log('🔴 Disconnected:', reason);
    isConnected = false;
    updateConnectionStatus('Disconnected');
    stopHeartbeat();
  });

  socket.on('connect_error', (error) => {
    console.log('❌ Connection error:', error);
    updateConnectionStatus('Connection Error');
  });

  socket.on('reconnect', (attemptNumber) => {
    console.log(`🔄 Reconnected after ${attemptNumber} attempts`);
    updateConnectionStatus('Reconnected');
  });

  socket.on('reconnect_failed', () => {
    console.log('❌ Failed to reconnect');
    updateConnectionStatus('Offline');
  });
}

function processQueuedMessage(message) {
  switch (message.type) {
    case 'contact-created':
      const existingIndex = contacts.findIndex(c => c.id === message.data.id);
      if (existingIndex === -1) {
        contacts.unshift(message.data);
      }
      break;
    case 'contact-updated':
      const updateIndex = contacts.findIndex(c => c.id === message.data.id);
      if (updateIndex !== -1) {
        contacts[updateIndex] = message.data;
      } else {
        contacts.unshift(message.data);
      }
      break;
    case 'contact-deleted':
      contacts = contacts.filter(c => c.id !== message.data.id);
      break;
  }
}

// Heartbeat mechanism
function startHeartbeat() {
  stopHeartbeat(); // Clear any existing interval
  heartbeatInterval = setInterval(() => {
    if (socket && isConnected) {
      socket.emit('heartbeat', {
        device_id: deviceId,
        timestamp: new Date().toISOString()
      });
    }
  }, 30000); // Every 30 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// Enhanced contact loading with better error handling
async function loadContacts(forceFullSync = false) {
  try {
    updateConnectionStatus('Syncing...');
    
    let url = `${API_URL}?device_id=${deviceId}`;
    let lastSyncTimestamp = localStorage.getItem('lastSyncTimestamp');
    
    // Force full sync by clearing timestamp or if requested
    if (forceFullSync || !lastSyncTimestamp) {
      localStorage.removeItem('lastSyncTimestamp');
      lastSyncTimestamp = null;
    }
    
    // Use delta sync if we have a timestamp and not forcing full sync
    if (lastSyncTimestamp && !forceFullSync) {
      url += `&since=${lastSyncTimestamp}`;
      console.log('🔄 Delta sync since:', lastSyncTimestamp);
    } else {
      console.log('🔄 Full sync requested');
    }

    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const data = await res.json();
    
    if (data.contacts) {
      if (lastSyncTimestamp && !forceFullSync) {
        // Delta sync - merge changes
        updateContactsFromDelta(data);
        console.log(`📊 Delta sync: +${data.contacts.length} contacts, -${data.deleted?.length || 0} deleted`);
      } else {
        // Full sync
        contacts = data.contacts;
        console.log(`📊 Full sync: ${contacts.length} contacts loaded`);
      }
    } else {
      // Fallback for old API response format
      contacts = Array.isArray(data) ? data : [];
    }

    // Update last sync timestamp
    if (data.server_timestamp) {
      localStorage.setItem('lastSyncTimestamp', data.server_timestamp);
    }

    displayContacts(contacts);
    updateConnectionStatus('Online');
    
  } catch (err) {
    console.error('❌ Error loading contacts:', err);
    updateConnectionStatus('Sync Error');
    
    // Try to load from cache or show error message
    if (contacts.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: red;">Failed to load contacts. Check connection.</td></tr>';
    }
  }
}

function updateContactsFromDelta(deltaData) {
  console.log('🔄 Processing delta sync:', deltaData);
  
  // Process new/updated contacts
  if (deltaData.contacts) {
    deltaData.contacts.forEach(newContact => {
      const existingIndex = contacts.findIndex(c => c.id === newContact.id);
      if (existingIndex !== -1) {
        contacts[existingIndex] = newContact;
      } else {
        contacts.unshift(newContact);
      }
    });
  }

  // Process deleted contacts
  if (deltaData.deleted) {
    deltaData.deleted.forEach(deletedContact => {
      contacts = contacts.filter(c => c.id !== deletedContact.id);
    });
  }
}

function displayContacts(data) {
  tableBody.innerHTML = '';
  if (!data || data.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No contacts found</td></tr>';
    return;
  }
  
  data.forEach(contact => {
    const row = document.createElement('tr');
    row.setAttribute('data-id', contact.id);
    row.innerHTML = `
      <td>${contact.client_name || ''}</td>
      <td>${contact.agent_name || ''}</td>
      <td>${contact.phone1 || ''}</td>
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
      console.log('✅ Contact created successfully');
    } else {
      const error = await res.json();
      alert(error.error || 'Failed to add contact');
    }
  } catch (err) {
    console.error('❌ Error adding contact:', err);
    alert('Failed to add contact. Check your connection.');
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
    
    if (res.ok) {
      console.log('✅ Contact deleted successfully');
    } else {
      alert('Failed to delete contact');
    }
  } catch (err) {
    console.error('❌ Error deleting contact:', err);
    alert('Failed to delete contact. Check your connection.');
  }
}

// Enhanced search
searchInput.addEventListener('input', () => {
  const value = searchInput.value.toLowerCase();
  const filtered = contacts.filter(c =>
    (c.client_name && c.client_name.toLowerCase().includes(value)) ||
    (c.phone1 && c.phone1.includes(value)) ||
    (c.agent_name && c.agent_name.toLowerCase().includes(value))
  );
  displayContacts(filtered);
});

// Initialize connection
connectWebSocket();

// Handle page visibility changes (tab switching)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !isConnected) {
    console.log('👀 Page became visible, attempting to reconnect...');
    connectWebSocket();
  }
});

// Handle online/offline events
window.addEventListener('online', () => {
  console.log('🌐 Browser is online');
  if (!isConnected) {
    connectWebSocket();
  }
});

window.addEventListener('offline', () => {
  console.log('📴 Browser is offline');
  updateConnectionStatus('Offline');
});