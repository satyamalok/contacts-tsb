require('dotenv').config(); // Load .env variables
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Optionally, add SSL config if needed later
});

module.exports = pool;
