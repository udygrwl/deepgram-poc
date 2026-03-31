// These variables hold the state of the current call
let websocket = null        // The WebSocket connection to our server
let audioContext = null      // Audio context for microphone capture
let sessionId = null        // The unique ID for this call session
let timerInterval = null    // Reference to the timer so we can stop it
let timerSeconds = 0        // How many seconds the call has been running
let escalationPollInterval = null  // Reference to the escalation polling interval
let speakerOverride = null          // null = use Deepgram diarization, 'Agent'/'Customer' = manual override
let speakersSwapped = false         // When true, swap Agent↔Customer labels from Deepgram

// Get references to HTML elements we'll need to update
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
    // Prevent double-clicks
    startBtn.disabled = true

    // Ask browser for microphone permission
    let stream
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        console.log('Microphone access granted')
    } catch (err) {
        console.error('Microphone error:', err)
        alert('Microphone access denied. Please allow microphone access and try again.')
        startBtn.disabled = false
        return
    }

    // Set up audio capture FIRST so we can send audio immediately when WS opens
    audioContext = new AudioContext({ sampleRate: 16000 })
    console.log('AudioContext created, sampleRate:', audioContext.sampleRate)

    // Connect to our FastAPI WebSocket endpoint
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`
    console.log('Connecting to WebSocket:', wsUrl)
    websocket = new WebSocket(wsUrl)

    websocket.onopen = () => {
        console.log('WebSocket connected')
        // Update UI to show call is live
        endBtn.disabled = false
        statusDot.classList.add('live')
        statusText.textContent = 'Live'

        // Remove empty state message
        if (emptyState) emptyState.remove()

        // Start the call timer
        startTimer()

        // Set up audio pipeline — use ScriptProcessor for immediate, synchronous audio capture
        // This avoids the async delay of AudioWorklet which can cause Deepgram to timeout
        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)

        processor.onaudioprocess = (e) => {
            if (!websocket || websocket.readyState !== WebSocket.OPEN) return
            const float32 = e.inputBuffer.getChannelData(0)
            const int16 = new Int16Array(float32.length)
            for (let i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
            }
            websocket.send(int16.buffer)
        }

        source.connect(processor)
        processor.connect(audioContext.destination)
        console.log('Audio pipeline ready')
    }

    // Handle messages coming from the server
    websocket.onmessage = (event) => {
        const data = JSON.parse(event.data)

        switch (data.type) {
            case 'session_started':
                sessionId = data.session_id
                console.log('Session started:', sessionId)
                startEscalationPolling()
                break

            case 'interim':
                interimText.textContent = data.text
                break

            case 'transcript':
                interimText.textContent = ''
                let speaker = speakerOverride || data.speaker
                if (!speakerOverride && speakersSwapped) {
                    speaker = speaker === 'Agent' ? 'Customer' : 'Agent'
                }
                addMessage(speaker, data.text, null)
                break

            case 'escalation':
                console.log('Escalation received:', data)
                updateEscalationButton(data.state)
                updateSentimentBar(data.sentiment)
                break

            case 'error':
                console.error('Server error:', data.message)
                break
        }
    }

    // Handle WebSocket closing
    websocket.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason)
        endCall()
    }

    // Handle WebSocket errors
    websocket.onerror = (error) => {
        console.error('WebSocket error:', error)
        endCall()
    }
}


function endCall() {
    // Stop the audio context
    if (audioContext) {
        audioContext.close().catch(() => {})
        audioContext = null
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
}


// ─── TRANSCRIPT DISPLAY ───────────────────────────────────────────────────────

function addMessage(speaker, text, sentiment) {
    const isAgent = speaker === 'Agent'

    const messageDiv = document.createElement('div')
    messageDiv.className = `message ${isAgent ? 'agent' : 'customer'}`

    const labelDiv = document.createElement('div')
    labelDiv.className = 'speaker-label'
    labelDiv.textContent = speaker

    const bubbleDiv = document.createElement('div')
    bubbleDiv.className = 'bubble'
    bubbleDiv.textContent = text

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

    messageDiv.appendChild(labelDiv)
    messageDiv.appendChild(bubbleDiv)
    transcriptContainer.appendChild(messageDiv)
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight
}


function getSentimentClass(sentiment) {
    if (sentiment > 0.2) return 'positive'
    if (sentiment < -0.2) return 'negative'
    return 'neutral'
}


// ─── ESCALATION ───────────────────────────────────────────────────────────────

function updateEscalationButton(state) {
    escalateBtn.className = 'escalate-btn'
    if (state !== 'normal') {
        escalateBtn.classList.add(state.replace('_', '-'))
    }
}


function startEscalationPolling() {
    escalationPollInterval = setInterval(async () => {
        if (!sessionId) return
        try {
            const response = await fetch(`/escalation/${sessionId}`)
            const data = await response.json()
            updateEscalationButton(data.state)
        } catch (err) {
            // Silently ignore polling errors
        }
    }, 1000)
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
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}


// ─── SPEAKER TOGGLE (TESTING) ────────────────────────────────────────────────

function toggleSpeaker() {
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

    const pct = ((sentiment + 1) / 2) * 100
    sentimentBarFill.style.width = `${pct}%`

    if (sentiment > 0.1) {
        const intensity = Math.min(sentiment, 1)
        sentimentBarFill.style.backgroundColor = `rgb(${34 + (1 - intensity) * 220}, ${197 + (1 - intensity) * 58}, ${99 + (1 - intensity) * 156})`
    } else if (sentiment < -0.1) {
        const intensity = Math.min(Math.abs(sentiment), 1)
        sentimentBarFill.style.backgroundColor = `rgb(${239}, ${68 + (1 - intensity) * 187}, ${68 + (1 - intensity) * 187})`
    } else {
        sentimentBarFill.style.backgroundColor = '#888'
    }
}