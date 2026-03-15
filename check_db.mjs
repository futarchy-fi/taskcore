import Database from 'better-sqlite3';

const dbPath = '/home/ubuntu/.openclaw/workspace/data/taskcore.db';
const db = new Database(dbPath);

try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables in database:', tables);
  
  // If there's a task or tasks table, show schema
  for (const table of tables) {
    if (table.name.includes('task') || table.name.includes('Task')) {
      console.log(`\nSchema for ${table.name}:`);
      const schema = db.prepare(`PRAGMA table_info(${table.name})`).all();
      console.log(schema);
    }
  }
  
} catch (error) {
  console.error('Error:', error);
} finally {
  db.close();
}
