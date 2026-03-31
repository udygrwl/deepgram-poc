import asyncio
import json
import uuid
import websockets
from storage import save_transcript
from analyzer import analyze_sentence, should_escalate
from dotenv import load_dotenv
import os
load_dotenv()

active_sessions = {}

DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&smart_format=true&interim_results=true&diarize=true&endpointing=200"

async def start_transcription_session(websocket):
    session_id = str(uuid.uuid4())
    active_sessions[session_id] = {
        "session_id": session_id,
        "escalation_state": "normal",
        "history": []
    }

    key = os.getenv("DEEPGRAM_API_KEY")
    headers = {"Authorization": f"Token {key}"}

    await websocket.send_json({"type": "session_started", "session_id": session_id})

    try:
        async with websockets.connect(DEEPGRAM_URL, extra_headers=headers, compression=None) as dg_ws:
            async def receive_from_deepgram():
                import time
                print(f"[{time.time():.2f}] receive_from_deepgram started")
                # Accumulate is_final chunks until speech_final
                pending_text = ""
                pending_words = []
                try:
                    async for message in dg_ws:
                        print(f"[{time.time():.2f}] DG message received: {str(message)[:100]}")
                        try:
                            data = json.loads(message)
                            transcript_text = data.get("channel", {}).get("alternatives", [{}])[0].get("transcript", "")
                            is_final = data.get("is_final", False)
                            speech_final = data.get("speech_final", False)

                            if not transcript_text.strip():
                                continue

                            if not is_final:
                                # Pure interim — show as in-progress
                                await websocket.send_json({
                                    "type": "interim",
                                    "text": pending_text + " " + transcript_text if pending_text else transcript_text
                                })
                                continue

                            # is_final=true — this chunk is finalized
                            chunk_words = data.get("channel", {}).get("alternatives", [{}])[0].get("words", [])
                            pending_text = (pending_text + " " + transcript_text).strip() if pending_text else transcript_text
                            pending_words.extend(chunk_words)

                            if not speech_final:
                                # More chunks coming — show accumulated text as interim
                                await websocket.send_json({
                                    "type": "interim",
                                    "text": pending_text
                                })
                                continue

                            # speech_final=true — utterance complete, use accumulated text + words
                            transcript_text = pending_text
                            words = pending_words
                            pending_text = ""
                            pending_words = []

                            # Split words into segments by speaker changes
                            segments = []
                            current_speaker = None
                            current_words = []
                            for w in words:
                                s = w.get("speaker", 0)
                                if s != current_speaker and current_words:
                                    segments.append((current_speaker, " ".join(cw.get("punctuated_word", cw.get("word", "")) for cw in current_words)))
                                    current_words = []
                                current_speaker = s
                                current_words.append(w)
                            if current_words:
                                segments.append((current_speaker, " ".join(cw.get("punctuated_word", cw.get("word", "")) for cw in current_words)))

                            # Send each speaker segment as its own transcript message
                            for speaker_num, segment_text in segments:
                                speaker = "Agent" if speaker_num == 0 else "Customer"
                                print(f"[{__import__('time').time():.2f}] Speaker: {speaker_num} -> {speaker} | '{segment_text[:50]}'")
                                await websocket.send_json({
                                    "type": "transcript",
                                    "speaker": speaker,
                                    "text": segment_text
                                })

                            # Track conversation history for contextual analysis
                            history = active_sessions[session_id]["history"]
                            history.append(f"{speaker}: {transcript_text}")
                            recent = history[-10:]  # last 10 lines

                            print(f"[{__import__('time').time():.2f}] Starting analysis with {len(recent)} lines of context")
                            analysis = await asyncio.to_thread(analyze_sentence, speaker, transcript_text, recent)
                            print(f"[{__import__('time').time():.2f}] Analysis result: {analysis}")
                            escalation_state = should_escalate(analysis)
                            active_sessions[session_id]["escalation_state"] = escalation_state

                            print(f"[{__import__('time').time():.2f}] Sending escalation: state={escalation_state}, sentiment={analysis.get('sentiment', 0)}")
                            await websocket.send_json({
                                "type": "escalation",
                                "state": escalation_state,
                                "keywords": analysis.get("keywords", []),
                                "sentiment": analysis.get("sentiment", 0)
                            })

                            save_transcript(
                                session_id=session_id,
                                speaker=speaker,
                                text=transcript_text,
                                sentiment=analysis.get("sentiment"),
                                escalation_risk=analysis.get("escalation_risk"),
                                keywords=json.dumps(analysis.get("keywords", []))
                            )

                        except Exception as e:
                            print(f"Error processing message: {e}")
                except Exception as e:
                    print(f"[{__import__('time').time():.2f}] Deepgram connection error: {e}")
                print(f"[{__import__('time').time():.2f}] receive_from_deepgram EXITED")

            async def send_to_deepgram():
                import time
                print(f"[{time.time():.2f}] send_to_deepgram started")
                try:
                    async for audio_chunk in websocket.iter_bytes():
                        print(f"[{time.time():.2f}] Sending {len(audio_chunk)} bytes to DG")
                        await dg_ws.send(audio_chunk)
                except Exception as e:
                    print(f"[{time.time():.2f}] Send error: {e}")
                print(f"[{time.time():.2f}] send_to_deepgram EXITED")

            await asyncio.gather(receive_from_deepgram(), send_to_deepgram())

    except websockets.exceptions.InvalidStatusCode as e:
        print(f"Status: {e.status_code}")
        raise

    return session_id
