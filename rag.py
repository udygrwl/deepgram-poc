# sqlite3 for reading from our database
import sqlite3

# json for handling keywords stored as JSON strings
import json

# We import our storage functions to query the database
from storage import get_connection

def get_rag_context(session_id: str, query: str = None) -> str:
    # This function retrieves transcript data formatted as context
    # for a language model to use
    # 
    # RAG = Retrieval Augmented Generation
    # Instead of the model relying only on its training data
    # we give it real transcript data as context
    # The model's answer is then grounded in actual call history
    
    conn = get_connection()
    cursor = conn.cursor()
    
    if query:
        # If a search query is provided, find relevant sentences
        # LIKE does a simple text search — not semantic, but fast and good enough for POC
        # In production you'd use vector embeddings for semantic search
        # but that requires a vector database like Pinecone or pgvector
        cursor.execute('''
            SELECT speaker, text, sentiment, escalation_risk, keywords, created_at
            FROM transcripts
            WHERE session_id = ?
            AND text LIKE ?
            ORDER BY created_at ASC
        ''', (session_id, f'%{query}%'))
    else:
        # No query — return the full transcript for this session
        cursor.execute('''
            SELECT speaker, text, sentiment, escalation_risk, keywords, created_at
            FROM transcripts
            WHERE session_id = ?
            ORDER BY created_at ASC
        ''', (session_id,))
    
    rows = cursor.fetchall()
    conn.close()
    
    if not rows:
        return "No transcript data found for this session."
    
    # Format the transcript into clean readable text
    # This is what gets injected into the LLM's context window
    # Good formatting here directly improves the quality of LLM responses
    lines = []
    
    for row in rows:
        row = dict(row)
        
        # Parse keywords back from JSON string to list
        # We stored them as a string — now we convert back
        try:
            keywords = json.loads(row["keywords"]) if row["keywords"] else []
        except:
            keywords = []
        
        # Build one line per sentence
        line = f"[{row['created_at']}] {row['speaker']}: {row['text']}"
        
        # Add escalation context if relevant
        # This helps the LLM understand emotional context of the call
        if row["escalation_risk"] in ("medium", "high"):
            line += f" [ESCALATION RISK: {row['escalation_risk']}]"
        
        # Add keywords if any were detected
        if keywords:
            line += f" [KEYWORDS: {', '.join(keywords)}]"
            
        lines.append(line)
    
    # Join all lines into one block of text
    context = "\n".join(lines)
    
    return context


def get_session_summary(session_id: str) -> dict:
    # Returns a summary of the call for reporting purposes
    # Useful for the PDF report and post-call analytics
    
    conn = get_connection()
    cursor = conn.cursor()
    
    # Get all transcripts for this session
    cursor.execute('''
        SELECT speaker, text, sentiment, escalation_risk, keywords
        FROM transcripts
        WHERE session_id = ?
        ORDER BY created_at ASC
    ''', (session_id,))
    
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    
    if not rows:
        return {}
    
    # Calculate average sentiment across the whole call
    # This gives a single number representing the overall call mood
    sentiments = [r["sentiment"] for r in rows if r["sentiment"] is not None]
    avg_sentiment = sum(sentiments) / len(sentiments) if sentiments else 0
    
    # Collect all keywords detected across the call
    all_keywords = []
    for row in rows:
        try:
            kw = json.loads(row["keywords"]) if row["keywords"] else []
            all_keywords.extend(kw)
        except:
            pass
    
    # Count how many escalation events occurred
    escalation_events = [
        r for r in rows 
        if r["escalation_risk"] in ("high", "medium")
    ]
    
    # Separate agent and customer turns
    agent_turns = [r for r in rows if r["speaker"] == "Agent"]
    customer_turns = [r for r in rows if r["speaker"] == "Customer"]
    
    return {
        "session_id": session_id,
        "total_turns": len(rows),
        "agent_turns": len(agent_turns),
        "customer_turns": len(customer_turns),
        "average_sentiment": round(avg_sentiment, 2),
        "escalation_events": len(escalation_events),
        "keywords_detected": list(set(all_keywords)),
        # set() removes duplicates — if "cancel" appeared 3 times, count it once
        "full_transcript": [
            {"speaker": r["speaker"], "text": r["text"]} 
            for r in rows
        ]
    }