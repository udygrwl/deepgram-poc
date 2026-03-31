# sqlite3 is Python's built-in database library — no install needed
# It creates a local file that works like a real database
import sqlite3

# os lets us work with file paths
import os

# This is the name of the database file that will be created on your desktop
DB_PATH = "contact_center.db"

def get_connection():
    # Creates a connection to the SQLite database file
    # If the file doesn't exist yet, SQLite creates it automatically
    conn = sqlite3.connect(DB_PATH)
    
    # This makes rows come back as dictionaries instead of plain tuples
    # So you get {"speaker": "Agent", "text": "Hello"} instead of ("Agent", "Hello")
    # Much easier to work with
    conn.row_factory = sqlite3.Row
    
    return conn

def init_db():
    # Get a connection to the database
    conn = get_connection()
    
    # cursor is how you send SQL commands to the database
    cursor = conn.cursor()
    
    # Create the transcripts table if it doesn't already exist
    # Each row is one sentence from the call
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS transcripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            speaker TEXT NOT NULL,
            text TEXT NOT NULL,
            sentiment REAL,
            escalation_risk TEXT,
            keywords TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Save the changes
    conn.commit()
    
    # Always close the connection when done
    conn.close()

def save_transcript(session_id, speaker, text, sentiment, escalation_risk, keywords):
    # This function saves one sentence to the database
    conn = get_connection()
    cursor = conn.cursor()
    
    # INSERT adds a new row to the transcripts table
    # The ? marks are placeholders — SQLite fills them in safely
    # Never use f-strings to build SQL queries — that's a security risk called SQL injection
    cursor.execute('''
        INSERT INTO transcripts (session_id, speaker, text, sentiment, escalation_risk, keywords)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (session_id, speaker, text, sentiment, escalation_risk, keywords))
    
    conn.commit()
    conn.close()

def get_transcripts(session_id):
    # Fetch all sentences for a given call session
    conn = get_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT * FROM transcripts 
        WHERE session_id = ?
        ORDER BY created_at ASC
    ''', (session_id,))
    
    # fetchall() returns all matching rows
    rows = cursor.fetchall()
    conn.close()
    
    # Convert rows to plain dictionaries so they can be sent as JSON
    return [dict(row) for row in rows]