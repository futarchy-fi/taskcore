import Database from 'better-sqlite3';

const dbPath = '/home/ubuntu/.openclaw/workspace/data/taskcore.db';
const db = new Database(dbPath);

const taskId = 2156;
const status = 'done';
const evidence = `Review passed: Comprehensive validation test suite delivered. All 78 tests pass (49 comprehensive + 29 base). Schema definitions include 4 layer types (working, project, profile, daily) with proper v0->v1 migration logic. Code quality is high: well-documented, type-hinted, proper error handling. All fixes mentioned in evidence are present: layer-specific field mappings (description->body for project, notes->body for daily), correct detection order (date before title+body), proper error reporting order. Tests cover edge cases, migration paths, data corruption, file operations, performance, and integration. Ready for merge.
Reviewer: coder-lite (parallel worker)
Review Date: 2026-03-14

Full review documented in task journal.`;

try {
  // Check if task exists
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    console.error('Task not found:', taskId);
    process.exit(1);
  }
  
  console.log('Current task status:', task.status);
  console.log('Task phase:', task.phase);
  
  // Update task status
  const result = db.prepare('UPDATE tasks SET status = ?, phase = ? WHERE id = ?').run(status, 'done', taskId);
  
  console.log('Update result:', result);
  console.log('Task updated successfully!');
  
  // Verify update
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  console.log('Updated task status:', updated.status);
  
} catch (error) {
  console.error('Error updating task:', error);
  process.exit(1);
} finally {
  db.close();
}
