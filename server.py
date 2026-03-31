# FastAPI is our web framework — the Python equivalent of Express
# It handles routing, requests, responses
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

# For serving our HTML/CSS/JS files as static files
from fastapi.staticfiles import StaticFiles

# For returning JSON responses
from fastapi.responses import JSONResponse

# Our own modules
from storage import init_db, get_transcripts
from transcriber import start_transcription_session, active_sessions
from rag import get_rag_context, get_session_summary

# load_dotenv reads your .env file
import os
from dotenv import load_dotenv
load_dotenv()

# Create the FastAPI app
# This is equivalent to const app = express() in Node
app = FastAPI()

# Initialize the database when the server starts
# This creates the SQLite file and tables if they don't exist
init_db()

# Serve everything in the public/ folder as static files
# When browser requests /app.js it gets public/app.js
# When browser requests /style.css it gets public/style.css
app.mount("/static", StaticFiles(directory="public"), name="static")


# HTTP GET endpoint — returns the main HTML page
# When someone goes to http://localhost:8000 they get index.html
@app.get("/")
async def root():
    # Read the HTML file and return it
    with open("public/index.html") as f:
        from fastapi.responses import HTMLResponse
        return HTMLResponse(content=f.read())


# WebSocket endpoint — this is the real-time connection
# Browser connects here to stream audio and receive transcripts
# ws://localhost:8000/ws is how the browser connects
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Accept the incoming WebSocket connection from the browser
    await websocket.accept()
    
    try:
        # Hand off to transcriber.py which manages the full session
        # This runs until the call ends
        session_id = await start_transcription_session(websocket)
        
    except WebSocketDisconnect:
        # Browser disconnected — normal end of call
        pass
    except Exception as e:
        # Something went wrong — log it
        print(f"WebSocket error: {e}")


# HTTP GET endpoint — returns all transcripts for a session
# Frontend calls this to get the full call history
# Example: GET /transcripts/abc-123
@app.get("/transcripts/{session_id}")
async def get_session_transcripts(session_id: str):
    transcripts = get_transcripts(session_id)
    return JSONResponse(content={"transcripts": transcripts})


# HTTP GET endpoint — returns RAG context for a session
# Optional query parameter for filtering
# Example: GET /rag/abc-123?query=refund
@app.get("/rag/{session_id}")
async def get_rag(session_id: str, query: str = None):
    # query is optional — if not provided returns full transcript
    context = get_rag_context(session_id, query)
    return JSONResponse(content={"context": context})


# HTTP GET endpoint — returns call summary and analytics
# Example: GET /summary/abc-123
@app.get("/summary/{session_id}")
async def get_summary(session_id: str):
    summary = get_session_summary(session_id)
    return JSONResponse(content=summary)


# HTTP GET endpoint — returns current escalation state
# Frontend polls this every second to update the button color
# Example: GET /escalation/abc-123
@app.get("/escalation/{session_id}")
async def get_escalation(session_id: str):
    # Check if session exists in memory
    session = active_sessions.get(session_id)
    
    if not session:
        return JSONResponse(content={"state": "normal"})
    
    return JSONResponse(content={
        "state": session["escalation_state"]
    })


# This block only runs when you execute server.py directly
# It starts the uvicorn server — uvicorn is what actually listens for connections
# The equivalent of server.listen(3000) in Node
if __name__ == "__main__":
    import uvicorn
    
    # host="0.0.0.0" means accept connections from any IP
    # not just localhost — needed for Railway deployment later
    # port=8000 is FastAPI's default — different from Node's 3000
    # reload=True means server restarts automatically when you save a file
    # Only use reload=True in development, never in production
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)