// These variables hold the state of the current call
// They're declared at the top so every function can access them
let websocket = null        // The WebSocket connection to our server
let sessionId = null        // The unique ID for this call session
let timerInterval = null    // Reference to the timer so we can stop it
let timerSeconds = 0        // How many seconds the call has been running
let escalationPollInterval = null  // Reference to the escalation polling interval
let speakerOverride = null          // null = use Deepgram diarization, 'Agent'/'Customer' = manual override
let speakersSwapped = false         // When true, swap Agent↔Customer labels from Deepgram

// Get references to HTML elements we'll need to update
// We do this once at the top instead of looking them up every time
const transcriptContainer = document.getElementById('transcriptContainer')
const interimText = document.getElementById('interimText')
const escalateBtn = document.getElementById('escalateBtn')
const startBtn = document.getElementById('startBtn')
const endBtn = document.getElementById('endBtn')
const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')
const timerEl = document.getElementById('timer')
const emptyState = document.getElementById('emptyState')
const sentimentBarFill = document.getElementById('sentimentBarFill')
const speakerToggleBtn = document.getElementById('speakerToggleBtn')


// ─── CALL LIFECYCLE ───────────────────────────────────────────────────────────

async function startCall() {
    // Ask browser for microphone permission
    // getUserMedia returns a stream of audio from the microphone
    let stream
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
        alert('Microphone access denied. Please allow microphone access and try again.')
        return
    }

    // Connect to our FastAPI WebSocket endpoint
    // ws:// is the WebSocket protocol — like http:// but for persistent connections
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    websocket = new WebSocket(`${wsProtocol}//${window.location.host}/ws`)

    // When WebSocket opens, start sending audio
    websocket.onopen = () => {
        // Update UI to show call is live
        startBtn.disabled = true
        endBtn.disabled = false
        statusDot.classList.add('live')
        statusText.textContent = 'Live'

        // Remove empty state message
        if (emptyState) emptyState.remove()

        // Start the call timer
        startTimer()

        // Use Web Audio API to capture raw PCM (linear16) — required by Deepgram live API
        // MediaRecorder sends containerized WebM which Deepgram rejects
        const audioContext = new AudioContext({ sampleRate: 16000 })
        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)

        processor.onaudioprocess = (e) => {
            if (websocket.readyState !== WebSocket.OPEN) return
            const float32 = e.inputBuffer.getChannelData(0)
            const int16 = new Int16Array(float32.length)
            for (let i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
            }
            websocket.send(int16.buffer)
        }

        source.connect(processor)
        processor.connect(audioContext.destination)

        // Store refs so endCall() can clean up
        websocket.audioContext = audioContext
        websocket.processor = processor
        websocket.source = source
    }

    // Handle messages coming from the server
    websocket.onmessage = (event) => {
        // Parse the JSON message
        const data = JSON.parse(event.data)

        // React based on message type
        // This is the message protocol we designed
        switch (data.type) {

            case 'session_started':
                // Server sent us our session ID
                // Store it so we can use it for API calls
                sessionId = data.session_id
                // Start polling for escalation state every second
                startEscalationPolling()
                break

            case 'interim':
                // In-progress transcript — show grayed out
                // Replaces previous interim text
                interimText.textContent = data.text
                break

            case 'transcript':
                // Final sentence — add to transcript
                interimText.textContent = ''
                // Use manual override if set, otherwise use Deepgram's diarization
                let speaker = speakerOverride || data.speaker
                // Swap if user toggled the swap button
                if (!speakerOverride && speakersSwapped) {
                    speaker = speaker === 'Agent' ? 'Customer' : 'Agent'
                }
                addMessage(speaker, data.text, null)
                break

            case 'escalation':
                // Update escalation button immediately when analysis comes in
                console.log('Escalation received:', data)
                updateEscalationButton(data.state)
                // Update the sentiment bar
                updateSentimentBar(data.sentiment)
                break

            case 'error':
                console.error('Server error:', data.message)
                break
        }
    }

    // Handle WebSocket closing
    websocket.onclose = () => {
        endCall()
    }

    // Handle WebSocket errors
    websocket.onerror = (error) => {
        console.error('WebSocket error:', error)
        endCall()
    }
}


function endCall() {
    // Stop everything cleanly

    // Stop the audio context if it's running
    if (websocket && websocket.audioContext) {
        websocket.audioContext.close()
    }

    // Close the WebSocket connection
    if (websocket) {
        websocket.close()
        websocket = null
    }

    // Stop the timer
    clearInterval(timerInterval)
    timerInterval = null

    // Stop polling for escalation
    clearInterval(escalationPollInterval)
    escalationPollInterval = null

    // Update UI to show call ended
    startBtn.disabled = false
    endBtn.disabled = true
    statusDot.classList.remove('live')
    statusText.textContent = 'Ended'
    escalateBtn.className = 'escalate-btn'
    // Reset button to white by removing all state classes
}


// ─── TRANSCRIPT DISPLAY ───────────────────────────────────────────────────────

function addMessage(speaker, text, sentiment) {
    // Create a new message bubble and add it to the transcript

    // Determine if this is agent or customer for styling
    const isAgent = speaker === 'Agent'

    // Create the outer message container
    const messageDiv = document.createElement('div')
    messageDiv.className = `message ${isAgent ? 'agent' : 'customer'}`
    // Template literal adds the right class based on speaker

    // Create the speaker label
    const labelDiv = document.createElement('div')
    labelDiv.className = 'speaker-label'
    labelDiv.textContent = speaker

    // Create the text bubble
    const bubbleDiv = document.createElement('div')
    bubbleDiv.className = 'bubble'
    bubbleDiv.textContent = text

    // Add a sentiment dot if we have sentiment data
    if (sentiment !== null && sentiment !== undefined) {
        const dot = document.createElement('span')
        dot.className = `sentiment-dot ${getSentimentClass(sentiment)}`
        bubbleDiv.appendChild(dot)
    }

    // Click to toggle speaker for demo purposes
    messageDiv.style.cursor = 'pointer'
    messageDiv.addEventListener('click', () => {
        const isCurrentlyAgent = messageDiv.classList.contains('agent')
        messageDiv.classList.toggle('agent', !isCurrentlyAgent)
        messageDiv.classList.toggle('customer', isCurrentlyAgent)
        labelDiv.textContent = isCurrentlyAgent ? 'Customer' : 'Agent'
    })

    // Assemble the message
    messageDiv.appendChild(labelDiv)
    messageDiv.appendChild(bubbleDiv)

    // Add to transcript container
    transcriptContainer.appendChild(messageDiv)

    // Auto scroll to the bottom so latest message is always visible
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight
}


function getSentimentClass(sentiment) {
    // Convert a sentiment number to a CSS class name
    // Used to color the sentiment dot in each bubble
    if (sentiment > 0.2) return 'positive'   // Green dot
    if (sentiment < -0.2) return 'negative'  // Red dot
    return 'neutral'                          // Gray dot
}


// ─── ESCALATION ───────────────────────────────────────────────────────────────

function updateEscalationButton(state) {
    // Update the escalation button appearance based on state
    // We do this by setting the className which CSS reacts to

    // Remove all existing state classes first
    escalateBtn.className = 'escalate-btn'

    // Add the new state class
    if (state !== 'normal') {
        escalateBtn.classList.add(state.replace('_', '-'))
        // replace('_', '-') converts escalate_now to escalate-now
        // CSS class names use hyphens, our state uses underscores
    }
}


function startEscalationPolling() {
    // Poll the escalation endpoint every second
    // This is the backup to the WebSocket escalation messages
    // Ensures the button is always in sync even if a message was missed
    escalationPollInterval = setInterval(async () => {
        if (!sessionId) return

        try {
            const response = await fetch(`/escalation/${sessionId}`)
            const data = await response.json()
            updateEscalationButton(data.state)
        } catch (err) {
            // Silently ignore polling errors
            // A failed poll just means one second of potential delay
        }
    }, 1000)
    // 1000 milliseconds = 1 second
}


// ─── TIMER ────────────────────────────────────────────────────────────────────

function startTimer() {
    timerSeconds = 0
    timerInterval = setInterval(() => {
        timerSeconds++
        timerEl.textContent = formatTime(timerSeconds)
    }, 1000)
}


function formatTime(seconds) {
    // Convert total seconds to MM:SS format
    // Math.floor rounds down — 90 seconds = 1 minute 30 seconds
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    // % is modulo — remainder after division. 90 % 60 = 30

    // padStart(2, '0') adds a leading zero if needed
    // So 5 seconds becomes "05" not "5"
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}


// ─── SPEAKER TOGGLE (TESTING) ────────────────────────────────────────────────

function toggleSpeaker() {
    // Cycle: Auto (null) → Agent → Customer → Auto
    if (speakerOverride === null) speakerOverride = 'Agent'
    else if (speakerOverride === 'Agent') speakerOverride = 'Customer'
    else speakerOverride = null

    const label = speakerOverride || 'Auto'
    speakerToggleBtn.textContent = `Speaker: ${label}`
    speakerToggleBtn.className = `speaker-toggle-btn ${speakerOverride ? speakerOverride.toLowerCase() : ''}`
}

function swapSpeakers() {
    speakersSwapped = !speakersSwapped
    document.getElementById('swapBtn').textContent = speakersSwapped ? 'Swap: ON' : 'Swap'

    // Retroactively swap all existing messages
    document.querySelectorAll('.message').forEach(msg => {
        const isAgent = msg.classList.contains('agent')
        msg.classList.toggle('agent', !isAgent)
        msg.classList.toggle('customer', isAgent)
        const label = msg.querySelector('.speaker-label')
        label.textContent = isAgent ? 'Customer' : 'Agent'
    })
}


// ─── SENTIMENT BAR ───────────────────────────────────────────────────────────

function updateSentimentBar(sentiment) {
    if (sentiment === null || sentiment === undefined) return

    // sentiment is -1 to +1, map to 0% to 100% width
    const pct = ((sentiment + 1) / 2) * 100

    sentimentBarFill.style.width = `${pct}%`

    // Color: red (-1) → white (0) → green (+1)
    if (sentiment > 0.1) {
        // Positive — green, brighter the higher
        const intensity = Math.min(sentiment, 1)
        sentimentBarFill.style.backgroundColor = `rgb(${34 + (1 - intensity) * 220}, ${197 + (1 - intensity) * 58}, ${99 + (1 - intensity) * 156})`
    } else if (sentiment < -0.1) {
        // Negative — red, brighter the lower
        const intensity = Math.min(Math.abs(sentiment), 1)
        sentimentBarFill.style.backgroundColor = `rgb(${239}, ${68 + (1 - intensity) * 187}, ${68 + (1 - intensity) * 187})`
    } else {
        // Neutral — white/gray
        sentimentBarFill.style.backgroundColor = '#888'
    }
}