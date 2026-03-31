# Anthropic's Python SDK — this is how we talk to Claude
import anthropic

# json lets us parse and create JSON data
import json

# os lets us read environment variables
import os

# load_dotenv reads your .env file and makes the keys available
from dotenv import load_dotenv
load_dotenv()

# Create one Anthropic client that the whole file uses
# It automatically reads ANTHROPIC_API_KEY from your .env
client = anthropic.Anthropic()

def analyze_sentence(speaker: str, text: str, history: list = None) -> dict:
    # Build conversation context from recent history
    context = ""
    if history and len(history) > 1:
        context = "Recent conversation:\n" + "\n".join(history) + "\n\n"

    prompt = f"""You are a contact center analysis engine. Analyze the overall interpersonal dynamic of this conversation and return ONLY a JSON object with no other text.

{context}Latest line — {speaker}: "{text}"

Base your analysis on the OVERALL conversation tone, not just the latest line:
- How is the customer feeling? Frustrated, angry, satisfied, confused?
- How is the agent performing? Empathetic, dismissive, helpful, rude, condescending?
- Is the interaction getting better or worse?

The sentiment should reflect the overall call health — the interpersonal dynamic between both speakers combined.

Be STRICT about agent quality. A good agent:
- Acknowledges the customer's frustration before troubleshooting
- Says things like "I understand", "Let me help", "I'm sorry about that"
- Guides the customer patiently

A bad agent:
- Jumps straight to blaming the customer ("Have you ever checked X?", "Did you even try X?")
- Asks questions that imply the customer is stupid or at fault
- Gives curt, minimal responses without empathy
- Interrupts the customer's explanation to ask unrelated questions
- Uses "have you ever" or "did you even" phrasing — this is condescending

If the agent is asking troubleshooting questions WITHOUT first acknowledging the customer's problem or showing empathy, that is poor agent behavior. Score it negative.

Return exactly this JSON structure:
{{
    "sentiment": <float between -1.0 (very negative/hostile) and 1.0 (very positive/friendly). 0 is neutral>,
    "escalation_risk": "<none|low|medium|high>",
    "keywords": [<list of concerning keywords found, empty list if none>],
    "escalate_now": <true if customer is clearly demanding escalation, otherwise false>,
    "agent_attitude": "<professional|neutral|poor>"
}}

Trigger keywords: "manager", "supervisor", "escalate", "unacceptable", "lawsuit", "cancel", "refund", "terrible", "useless"
Agent red flags: dismissiveness, blame-shifting, "have you ever/did you even" phrasing, ignoring concerns, lack of empathy, condescension, impatience, cutting off customer's explanation.
"""

    response = client.messages.create(
        # Haiku is fast and cheap — perfect for real-time sentence analysis
        # It runs on every single sentence so cost and speed matter
        model="claude-haiku-4-5",
        
        # We don't need a long response — just a small JSON object
        max_tokens=256,
        
        messages=[
            {"role": "user", "content": prompt}
        ]
    )
    
    # Get the text response from Claude
    raw = response.content[0].text

    # Strip markdown code fences if Claude wraps the JSON in ```json ... ```
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1]  # remove first line (```json)
        cleaned = cleaned.rsplit("```", 1)[0]  # remove closing ```
        cleaned = cleaned.strip()

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        # If Claude returns something unexpected, return safe defaults
        # This prevents one bad response from crashing the whole system
        result = {
            "sentiment": 0.0,
            "escalation_risk": "none",
            "keywords": [],
            "escalate_now": False
        }
    
    return result

def should_escalate(analysis: dict) -> str:
    # This function reads the analysis and returns one of three escalation states
    # These states map directly to the frontend button colors

    # "escalate_now" means the customer explicitly asked — blink red immediately
    if analysis.get("escalate_now"):
        return "escalate_now"

    # Poor agent attitude is a red flag — suggest escalation
    if analysis.get("agent_attitude") == "poor":
        return "suggest"

    # High risk or very negative sentiment — turn button solid red
    if analysis.get("escalation_risk") == "high" or analysis.get("sentiment", 0) < -0.6:
        return "suggest"

    # Medium risk or moderately negative — turn button solid red but less urgent
    if analysis.get("escalation_risk") == "medium" or analysis.get("sentiment", 0) < -0.3:
        return "warn"

    # Everything else — button stays white
    return "normal"