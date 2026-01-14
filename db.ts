import { Database } from "bun:sqlite";

const db = new Database("db.sqlite");

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    current_study_key TEXT,
    is_trusted BOOLEAN DEFAULT 0
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS usernames (
    username TEXT PRIMARY KEY,
    user_id INTEGER
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_key TEXT,
    question_text TEXT,
    options TEXT, -- JSON array of strings
    correct_index INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    thumbs_up INTEGER DEFAULT 0,
    thumbs_down INTEGER DEFAULT 0
    -- Removed last_used_at from here as usage is now per-user
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS votes (
    user_id INTEGER,
    question_id INTEGER,
    vote INTEGER, -- 1 for up, -1 for down
    PRIMARY KEY (user_id, question_id)
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS user_progress (
    user_id INTEGER,
    question_id INTEGER,
    last_used_at INTEGER,
    PRIMARY KEY (user_id, question_id)
  );
`);

export function renameStudyKey(oldKey: string, newKey: string) {
  db.transaction(() => {
    // Update questions
    db.query("UPDATE questions SET study_key = $newKey WHERE study_key = $oldKey").run({
      $newKey: newKey,
      $oldKey: oldKey
    });

    // Update users' current selection so they don't get lost
    db.query("UPDATE users SET current_study_key = $newKey WHERE current_study_key = $oldKey").run({
      $newKey: newKey,
      $oldKey: oldKey
    });
  })();
}

export function setUserStudyKey(userId: number, key: string) {
  const query = db.query(`
    INSERT INTO users (id, current_study_key, is_trusted) 
    VALUES ($id, $key, 0) 
    ON CONFLICT(id) DO UPDATE SET current_study_key = $key
  `);
  query.run({ $id: userId, $key: key });
}

export function setTrusted(userId: number, isTrusted: boolean) {
  const query = db.query(`
    INSERT INTO users (id, is_trusted) 
    VALUES ($id, $isTrusted) 
    ON CONFLICT(id) DO UPDATE SET is_trusted = $isTrusted
  `);
  query.run({ $id: userId, $isTrusted: isTrusted ? 1 : 0 });
}

export function isTrusted(userId: number): boolean {
  const query = db.query("SELECT is_trusted FROM users WHERE id = $id");
  const result = query.get({ $id: userId }) as { is_trusted: number } | null;
  return result ? !!result.is_trusted : false;
}

export function saveUsername(userId: number, username: string) {
  const query = db.query(`
    INSERT INTO usernames (username, user_id) 
    VALUES ($username, $userId) 
    ON CONFLICT(username) DO UPDATE SET user_id = $userId
  `);
  query.run({ $username: username.replace("@", ""), $userId: userId });
}

export function getUserIdByUsername(username: string): number | null {
  const query = db.query("SELECT user_id FROM usernames WHERE username = $username");
  const result = query.get({ $username: username.replace("@", "") }) as { user_id: number } | null;
  return result ? result.user_id : null;
}

export function getUserStudyKey(userId: number): string | null {
  const query = db.query("SELECT current_study_key FROM users WHERE id = $id");
  const result = query.get({ $id: userId }) as { current_study_key: string } | null;
  return result ? result.current_study_key : null;
}

export function getAllStudyKeys(): string[] {
  const query = db.query("SELECT DISTINCT study_key FROM questions ORDER BY study_key ASC");
  const results = query.all() as { study_key: string }[];
  return results.map(r => r.study_key);
}

export function getQuestionCount(studyKey: string): number {
  const query = db.query("SELECT COUNT(*) as count FROM questions WHERE study_key = $studyKey");
  const result = query.get({ $studyKey: studyKey }) as { count: number };
  return result ? result.count : 0;
}

export function saveQuestion(studyKey: string, question: string, options: string[], correctIndex: number): number {
  const query = db.query(`
    INSERT INTO questions (study_key, question_text, options, correct_index)
    VALUES ($studyKey, $question, $options, $correctIndex)
    RETURNING id
  `);
  const result = query.get({
    $studyKey: studyKey,
    $question: question,
    $options: JSON.stringify(options),
    $correctIndex: correctIndex
  }) as { id: number };
  
  return result.id;
}

export function clearQuestions(studyKey: string) {
  const query = db.query("DELETE FROM questions WHERE study_key = $studyKey");
  query.run({ $studyKey: studyKey });
}

export function addVote(userId: number, questionId: number, isUpvote: boolean) {
  const voteVal = isUpvote ? 1 : -1;
  
  // Check existing vote
  const existing = db.query("SELECT vote FROM votes WHERE user_id = $uid AND question_id = $qid").get({
    $uid: userId,
    $qid: questionId
  }) as { vote: number } | null;

  if (existing) {
    if (existing.vote === voteVal) return; // No change
    
    // Changing vote (e.g. up to down)
    db.transaction(() => {
      db.query("UPDATE votes SET vote = $vote WHERE user_id = $uid AND question_id = $qid").run({
        $vote: voteVal,
        $uid: userId,
        $qid: questionId
      });
      
      if (isUpvote) {
        db.query("UPDATE questions SET thumbs_up = thumbs_up + 1, thumbs_down = thumbs_down - 1 WHERE id = $qid").run({ $qid: questionId });
      } else {
        db.query("UPDATE questions SET thumbs_down = thumbs_down + 1, thumbs_up = thumbs_up - 1 WHERE id = $qid").run({ $qid: questionId });
      }
    })();
  } else {
    // New vote
    db.transaction(() => {
      db.query("INSERT INTO votes (user_id, question_id, vote) VALUES ($uid, $qid, $vote)").run({
        $uid: userId,
        $qid: questionId,
        $vote: voteVal
      });

      if (isUpvote) {
        db.query("UPDATE questions SET thumbs_up = thumbs_up + 1 WHERE id = $qid").run({ $qid: questionId });
      } else {
        db.query("UPDATE questions SET thumbs_down = thumbs_down + 1 WHERE id = $qid").run({ $qid: questionId });
      }
    })();
  }
}

export function getQuestionStats(questionId: number) {
  const query = db.query("SELECT thumbs_up, thumbs_down FROM questions WHERE id = $id");
  const result = query.get({ $id: questionId }) as { thumbs_up: number, thumbs_down: number } | null;
  return result || { thumbs_up: 0, thumbs_down: 0 };
}

export function getQuestionById(questionId: number) {
  const query = db.query("SELECT * FROM questions WHERE id = $id");
  const result = query.get({ $id: questionId }) as any;
  if (result) {
    return {
      ...result,
      options: JSON.parse(result.options) as string[]
    };
  }
  return null;
}

export function getQuestions(studyKey: string, page: number, pageSize: number = 5) {
  const offset = (page - 1) * pageSize;
  const query = db.query(`
    SELECT id, question_text, options, correct_index, thumbs_up, thumbs_down,
    (CAST(thumbs_up AS REAL) + 1.0) / (CAST(thumbs_up AS REAL) + CAST(thumbs_down AS REAL) + 2.0) as rating
    FROM questions 
    WHERE study_key = $studyKey 
    ORDER BY rating ASC, id DESC
    LIMIT $limit OFFSET $offset
  `);
  
  const totalQuery = db.query("SELECT COUNT(*) as count FROM questions WHERE study_key = $studyKey");
  const total = (totalQuery.get({ $studyKey: studyKey }) as { count: number }).count;
  
  const questions = query.all({ 
    $studyKey: studyKey, 
    $limit: pageSize, 
    $offset: offset 
  }) as { id: number, question_text: string, options: string, correct_index: number, thumbs_up: number, thumbs_down: number }[];

  return { questions, total, totalPages: Math.ceil(total / pageSize) };
}

export function getAllQuestionsRaw() {
  const query = db.query("SELECT id, study_key, question_text, options, correct_index FROM questions");
  return query.all() as { id: number, study_key: string, question_text: string, options: string, correct_index: number }[];
}

export function updateQuestionOptions(id: number, options: string[], correctIndex: number) {
  const query = db.query("UPDATE questions SET options = $options, correct_index = $correctIndex WHERE id = $id");
  query.run({ $id: id, $options: JSON.stringify(options), $correctIndex: correctIndex });
}

export function deleteQuestion(questionId: number) {
  db.run("DELETE FROM questions WHERE id = $id", { $id: questionId });
  db.run("DELETE FROM votes WHERE question_id = $id", { $id: questionId });
  db.run("DELETE FROM user_progress WHERE question_id = $id", { $id: questionId });
}

export function getRandomQuestion(studyKey: string, userId: number) {
  // First try to find questions never used BY THIS USER
  // Sort by approval rate: (thumbs_up + 1) / (thumbs_up + thumbs_down + 2)
  let query = db.query(`
    SELECT q.*,
      (CAST(q.thumbs_up AS REAL) + 1.0) / (CAST(q.thumbs_up AS REAL) + CAST(q.thumbs_down AS REAL) + 2.0) as weight
    FROM questions q
    LEFT JOIN user_progress up ON q.id = up.question_id AND up.user_id = $userId
    WHERE q.study_key = $studyKey AND up.last_used_at IS NULL
    ORDER BY weight DESC, RANDOM()
    LIMIT 1
  `);
  
  let result = query.get({ $studyKey: studyKey, $userId: userId }) as any;

  // If no unused questions, pick the Least Recently Used (LRU) for this user
  if (!result) {
      query = db.query(`
        SELECT q.* 
        FROM questions q
        JOIN user_progress up ON q.id = up.question_id
        WHERE q.study_key = $studyKey AND up.user_id = $userId
        ORDER BY up.last_used_at ASC
        LIMIT 1
      `);
      result = query.get({ $studyKey: studyKey, $userId: userId }) as any;
  }
  
  // If still no result (maybe edge case where only some have progress but filtering logic missed),
  // fallback to ANY question in the group (should have been covered by first query if partial progress exists)
  // But strictly: if all have progress, query 2 covers it. If some have progress, query 1 covers the rest.
  // The only case result is null is if there are NO questions for this studyKey at all.
  if (!result) {
       query = db.query(`SELECT * FROM questions WHERE study_key = $studyKey LIMIT 1`);
       result = query.get({ $studyKey: studyKey }) as any;
  }

  if (result) {
    // Update or Insert last_used_at for this user
    const update = db.query(`
      INSERT INTO user_progress (user_id, question_id, last_used_at)
      VALUES ($userId, $questionId, $now)
      ON CONFLICT(user_id, question_id) DO UPDATE SET last_used_at = $now
    `);
    update.run({ $userId: userId, $questionId: result.id, $now: Date.now() });

    return {
      ...result,
      options: JSON.parse(result.options) as string[]
    };
  }
  return null;
}
