const API_URL = '/contacts';

const tableBody = document.getElementById('contact-table-body');
const form = document.getElementById('contact-form');
const searchInput = document.getElementById('search');

let contacts = [];

// ✅ Connect to WebSocket
const socket = io();

// ✅ Listen for added contact from other tabs
socket.on('contact-added', (contact) => {
  contacts.unshift(contact); // add to top
  displayContacts(contacts);
});

// ✅ Listen for deleted contact from other tabs
socket.on('contact-deleted', ({ id }) => {
  contacts = contacts.filter(c => c.id !== id);
  displayContacts(contacts);
});

// (optional) Listen for updates (future)
socket.on('contact-updated', (updated) => {
  const index = contacts.findIndex(c => c.id === updated.id);
  if (index !== -1) {
    contacts[index] = updated;
    displayContacts(contacts);
  }
});

async function loadContacts() {
  try {
    const res = await fetch(API_URL);
    contacts = await res.json();
    displayContacts(contacts);
  } catch (err) {
    console.error('Error loading contacts:', err);
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
    device_id: 'web'
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      form.reset();
      // No need to call loadContacts(); the socket will auto-update
    } else {
      const error = await res.json();
      alert(error.error || 'Failed to add contact');
    }
  } catch (err) {
    console.error('Error adding contact:', err);
  }
});

async function deleteContact(id) {
  if (!confirm('Are you sure you want to delete this contact?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    if (res.ok) {
      // No need to call loadContacts(); the socket will auto-update
    } else {
      alert('Failed to delete contact');
    }
  } catch (err) {
    console.error('Error deleting contact:', err);
  }
}

searchInput.addEventListener('input', () => {
  const value = searchInput.value.toLowerCase();
  const filtered = contacts.filter(c =>
    c.client_name.toLowerCase().includes(value) ||
    c.phone1.includes(value)
  );
  displayContacts(filtered);
});

loadContacts();
