import { useState, useRef, useEffect, useCallback } from 'react'
import { MessageSquare, Mic, MicOff, Send, Volume2, X } from 'lucide-react'
import ArisaCharacter, { inferArisaEmotion } from './ArisaCharacter'

const API              = '/api'
const SILENCE_MS       = 550  // Begin processing sooner after a natural pause
const SPEECH_START_MS  = 150  // Reject brief clicks while arming quickly
const VAD_CALIBRATION_MS = 300 // Establish the room's noise level before adapting the voice gate
const MAX_RECORD_MS    = 300000 // Safety limit for an unattended recording (5 minutes)
const MIN_BLOB_BYTES   = 1500  // Ignore clicks while retaining short, quiet utterances

async function readApiResult(response, label) {
  const body = await response.text()
  let data = null
  try { data = body ? JSON.parse(body) : null } catch {}
  if (!response.ok) {
    const detail = data?.detail || body?.slice(0, 240)
    throw new Error(detail || `${label} failed (HTTP ${response.status}).`)
  }
  if (!data) throw new Error(`${label} returned an empty or invalid response.`)
  return data
}

/** Pick the best supported audio MIME type for this browser. */
function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  return candidates.find(t => {
    try { return MediaRecorder.isTypeSupported(t) } catch { return false }
  }) || ''
}

function speakWithSystemVoice(text, playbackRef, playback) {
  const engine = window.speechSynthesis
  if (!engine || !window.SpeechSynthesisUtterance) {
    return Promise.reject(new Error('This device does not provide a built-in speech voice.'))
  }
  engine.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = 0.94
  utterance.pitch = 0.96
  const voices = engine.getVoices()
  utterance.voice = voices.find(voice => /michelle|monica|serena|sonia|jane|hazel|susan/i.test(voice.name))
    || voices.find(voice => voice.lang?.toLowerCase().startsWith('en-us'))
    || voices.find(voice => voice.lang?.toLowerCase().startsWith('en'))
    || null
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = error => {
      if (settled) return
      settled = true
      if (playbackRef.current === playback) playbackRef.current = null
      if (error) reject(error)
      else resolve()
    }
    playback.cancel = () => {
      playback.cancelled = true
      engine.cancel()
      settle()
    }
    playbackRef.current = playback
    utterance.onend = () => settle()
    utterance.onerror = event => playback.cancelled
      ? settle()
      : settle(new Error(event.error || 'System speech playback failed.'))
    engine.speak(utterance)
  })
}

function removeToneLabel(text = '') {
  return text.replace(/^\s*\[Tone:\s*[^\]]+\]\s*/i, '').trim()
}

export default function VoiceMode({ onSwitchToText, desktopMode = false }) {
  // ── UI state ──────────────────────────────────────────────────────────────
  const [orbState,        setOrbStateUI]      = useState('idle')
  const [transcript,      setTranscript]      = useState('')
  const [reply,           setReply]           = useState('')
  const [error,           setError]           = useState('')
  const [sessionOn,       setSessionOn]       = useState(false)
  const [micAnalyser,     setMicAnalyser]     = useState(null)
  const [speakerAnalyser, setSpeakerAnalyser] = useState(null)
  const [statusHint,      setStatusHint]      = useState('')
  const [textInput,       setTextInput]       = useState('')
  const [textBusy,        setTextBusy]        = useState(false)
  const [apiStatus,       setApiStatus]       = useState('checking')
  const [arisaEmotion,    setArisaEmotion]    = useState('neutral')

  // ── Refs (used inside callbacks to avoid stale closures) ─────────────────
  const orbStateRef    = useRef('idle')
  const sessionRef     = useRef(false)
  const convIdRef      = useRef(null)
  const recorderRef    = useRef(null)
  const chunksRef      = useRef([])
  const speechPlaybackRef = useRef(null)
  const streamedReplyCancelRef = useRef(null)
  const startListeningRef = useRef(null)
  const pendingListenRef = useRef(false)
  const streamRef      = useRef(null)
  const audioCtxRef    = useRef(null)
  const micAnalyserRef = useRef(null)
  const silenceRafRef  = useRef(null)
  const audioElRef     = useRef(null)

  useEffect(() => {
    let stopped = false
    let retryTimer
    const checkApi = async () => {
      try {
        const response = await fetch(`${API}/health`, { cache: 'no-store' })
        if (!response.ok) throw new Error('API is not ready')
        const health = await response.json()
        if (!stopped) setApiStatus(health.groq_configured ? 'ready' : 'unconfigured')
      } catch {
        if (!stopped) {
          setApiStatus('checking')
          retryTimer = setTimeout(checkApi, 500)
        }
      }
    }
    checkApi()
    return () => { stopped = true; clearTimeout(retryTimer) }
  }, [])

  /** Sync state + matching ref together. */
  const setOrbState = s => { orbStateRef.current = s; setOrbStateUI(s) }
  const setSession  = v => { sessionRef.current  = v; setSessionOn(v)  }

  const cancelSpeechPlayback = () => {
    const cancelStreamedReply = streamedReplyCancelRef.current
    streamedReplyCancelRef.current = null
    cancelStreamedReply?.()

    const playback = speechPlaybackRef.current
    speechPlaybackRef.current = null
    playback?.cancel?.()

    const audio = audioElRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
      audio.removeAttribute('src')
      audio.load()
    }
    audioElRef.current = null
    window.speechSynthesis?.cancel()
  }

  // Tear everything down on unmount
  useEffect(() => () => _teardown(), [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Internal cleanup ──────────────────────────────────────────────────────
  const _teardown = () => {
    if (silenceRafRef.current) cancelAnimationFrame(silenceRafRef.current)
    if (recorderRef.current?.state !== 'inactive') {
      try { recorderRef.current?.stop() } catch {}
    }
    streamRef.current?.getTracks().forEach(t => t.stop())
    cancelSpeechPlayback()
    if (audioCtxRef.current?.state !== 'closed') {
      try { audioCtxRef.current?.close() } catch {}
    }
    streamRef.current      = null
    audioCtxRef.current    = null
    micAnalyserRef.current = null
    setMicAnalyser(null)
    setSpeakerAnalyser(null)
  }

  // ── Stop recording (without teardown) ────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (silenceRafRef.current) cancelAnimationFrame(silenceRafRef.current)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current      = null
    micAnalyserRef.current = null
    setMicAnalyser(null)
  }, [])

  // ── TTS playback ──────────────────────────────────────────────────────────
  const playTTS = useCallback(async (text, immediate = false, { streamChunk = false } = {}) => {
    setArisaEmotion(inferArisaEmotion(text))
    const spokenText = removeToneLabel(text)
    if (!spokenText) return
    const playback = { cancelled: false, cancel: null }
    if (immediate) {
      setStatusHint('Speaking…')
      setOrbState('speaking')
      try {
        await speakWithSystemVoice(spokenText, speechPlaybackRef, playback)
      } catch (e) {
        if (!playback.cancelled) setError(`Arisa couldn't speak the confirmation. ${e.message || ''}`.trim())
      } finally {
        if (speechPlaybackRef.current === playback) speechPlaybackRef.current = null
        setStatusHint('')
        if (sessionRef.current && !playback.cancelled) {
          setOrbState('idle')
          setTimeout(() => { if (sessionRef.current) startListeningRef.current?.() }, 200)
        }
        else setOrbState('idle')
      }
      return
    }
    setStatusHint('Speaking…')
    let audio = null
    try {
      // Play progressive audio chunks in both web and desktop voice mode so
      // playback can begin before the entire response has been synthesized.
      const streamUrl = `${API}/arisa/tts/stream?text=${encodeURIComponent(spokenText)}`
      audio = new Audio(streamUrl)
      audio.preload = 'auto'
      audioElRef.current = audio

      // Wire up Web Audio for the speaking visualiser
      const actx = new AudioContext()
      audioCtxRef.current = actx
      const src  = actx.createMediaElementSource(audio)
      const an   = actx.createAnalyser(); an.fftSize = 1024
      src.connect(an); an.connect(actx.destination)
      setSpeakerAnalyser(an)
      setOrbState('speaking')

      await new Promise((resolve, reject) => {
        let settled = false
        const settle = error => {
          if (settled) return
          settled = true
          if (speechPlaybackRef.current === playback) speechPlaybackRef.current = null
          if (error) reject(error)
          else resolve()
        }
        playback.cancel = () => {
          playback.cancelled = true
          audio.pause()
          audio.currentTime = 0
          audio.removeAttribute('src')
          audio.load()
          settle()
        }
        speechPlaybackRef.current = playback
        audio.onended = () => settle()
        audio.onerror = () => playback.cancelled
          ? settle()
          : settle(new Error('The generated audio could not be played.'))
        audio.play().catch(settle)
      })
    } catch (e) {
      try {
        if (playback.cancelled) return
        audioElRef.current?.pause()
        if (audioCtxRef.current?.state !== 'closed') await audioCtxRef.current?.close()
        audioCtxRef.current = null
        setSpeakerAnalyser(null)
        setStatusHint('Speaking with your device voice…')
        setOrbState('speaking')
        await speakWithSystemVoice(spokenText, speechPlaybackRef, playback)
      } catch (fallbackError) {
        if (!playback.cancelled) setError(`Arisa could not speak. ${e.message || 'TTS API failed.'} ${fallbackError.message || ''}`.trim())
      }
    } finally {
      if (speechPlaybackRef.current === playback) speechPlaybackRef.current = null
      if (audioElRef.current === audio) audioElRef.current = null
      setSpeakerAnalyser(null)
      if (audioCtxRef.current?.state !== 'closed') {
        try { await audioCtxRef.current.close() } catch {}
      }
      audioCtxRef.current = null
      if (!streamChunk) {
        setStatusHint('')
        // Auto-loop: jump straight back into listening if the session is still on
        if (sessionRef.current && !playback.cancelled) {
          setOrbState('idle')
          setTimeout(() => { if (sessionRef.current) startListeningRef.current?.() }, 250)
        } else {
          setOrbState('idle')
        }
      }
    }
  }, [])

  // ── Process audio blob → backend ──────────────────────────────────────────
  const processAudio = useCallback(async blob => {
    if (blob.size < MIN_BLOB_BYTES) { setOrbState('idle'); return }
    setOrbState('thinking')
    setMicAnalyser(null)
    setReply('')
    setError('')
    setStatusHint('Transcribing…')

    const controller = new AbortController()
    const speechQueue = []
    let speechDraining = false
    let responseFinished = false
    let cancelled = false
    let partialReply = ''
    let receivedSentence = false
    let resolveSpeechComplete
    const speechComplete = new Promise(resolve => { resolveSpeechComplete = resolve })

    const finishResponse = () => {
      if (cancelled || !responseFinished || speechDraining || speechQueue.length) return
      if (streamedReplyCancelRef.current === cancelStreamedResponse) streamedReplyCancelRef.current = null
      setSpeakerAnalyser(null)
      setStatusHint('')
      setOrbState('idle')
      if (sessionRef.current) {
        setTimeout(() => { if (sessionRef.current) startListeningRef.current?.() }, 180)
      }
      resolveSpeechComplete()
    }

    const cancelStreamedResponse = () => {
      if (cancelled) return
      cancelled = true
      responseFinished = true
      speechQueue.length = 0
      controller.abort()
      resolveSpeechComplete()
    }
    streamedReplyCancelRef.current = cancelStreamedResponse

    const drainSpeechQueue = async () => {
      if (speechDraining) return
      speechDraining = true
      while (speechQueue.length && !cancelled) {
        await playTTS(speechQueue.shift(), false, { streamChunk: true })
      }
      speechDraining = false
      finishResponse()
    }

    const handleEvent = frame => {
      const lines = frame.split('\n')
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!event || !data) return
      const payload = JSON.parse(data)

      if (event === 'transcript') {
        setTranscript(payload.user_transcript || '')
        convIdRef.current = payload.conversation_id || convIdRef.current
        setStatusHint('Thinking…')
      } else if (event === 'sentence') {
        const sentence = String(payload.text || '').trim()
        if (!sentence) return
        receivedSentence = true
        partialReply = partialReply ? `${partialReply} ${sentence}` : sentence
        setReply(partialReply)
        setArisaEmotion(inferArisaEmotion(partialReply))
        speechQueue.push(sentence)
        void drainSpeechQueue()
      } else if (event === 'done') {
        responseFinished = true
        const finalReply = payload.reply || partialReply
        setReply(finalReply)
        setArisaEmotion(inferArisaEmotion(finalReply))
        if (!receivedSentence && finalReply) {
          speechQueue.push(finalReply)
          void drainSpeechQueue()
        }
        finishResponse()
      } else if (event === 'error') {
        throw new Error(payload.detail || 'Voice request failed.')
      }
    }

    try {
      const fd = new FormData()
      fd.append('file', blob, 'voice.webm')
      if (convIdRef.current) fd.append('conversation_id', convIdRef.current)
      fd.append('desktop_mode', String(desktopMode))
      fd.append('stream_response', 'true')

      const res = await fetch(`${API}/arisa/voice`, { method: 'POST', body: fd, signal: controller.signal })
      if (!res.ok) throw new Error((await readApiResult(res, 'Voice API request')).detail || 'Voice API request failed.')
      if (!res.body) throw new Error('The voice API did not open a response stream.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          handleEvent(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) handleEvent(buffer)
      if (!responseFinished && !cancelled) throw new Error('Arisa’s response stream ended unexpectedly.')
      await speechComplete
    } catch (e) {
      if (!cancelled) {
        cancelSpeechPlayback()
        setError(e.message === 'Failed to fetch'
          ? 'Could not reach the voice API. Make sure Arisa’s backend is running, then try again.'
          : e.message || 'Voice request failed.')
        setSpeakerAnalyser(null)
        setOrbState('idle')
        setStatusHint('')
      }
    }
  }, [desktopMode, playTTS])

  // ── Start listening ───────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    if (orbStateRef.current === 'listening') return
    if (apiStatus === 'checking') {
      pendingListenRef.current = true
      setError('')
      setStatusHint('Arisa is starting…')
      return
    }
    if (apiStatus === 'unconfigured') {
      pendingListenRef.current = false
      setStatusHint('')
      setError('Add your Groq API key to finish setting up Arisa.')
      return
    }
    pendingListenRef.current = false
    setError('')
    setStatusHint('Waiting for you to speak…')

    try {
      // Ask the browser's microphone pipeline to suppress noise and keep voice
      // levels steady. These are best-effort constraints because support varies.
      const supported = navigator.mediaDevices.getSupportedConstraints?.() || {}
      const audioConstraints = {
        echoCancellation: supported.echoCancellation ? { ideal: true } : true,
        noiseSuppression: supported.noiseSuppression ? { ideal: true } : true,
        autoGainControl: supported.autoGainControl ? { ideal: true } : true,
      }
      if (supported.channelCount) audioConstraints.channelCount = { ideal: 1 }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      })
      streamRef.current = stream

      // Keep the visualiser on the processed mic signal, and apply a speech
      // band-pass filter only to the VAD analysis. The recorder still captures
      // the browser-cleaned microphone stream for Whisper.
      const actx = new AudioContext()
      audioCtxRef.current = actx
      const src  = actx.createMediaStreamSource(stream)
      const an   = actx.createAnalyser(); an.fftSize = 1024
      src.connect(an)
      const highPass = actx.createBiquadFilter()
      highPass.type = 'highpass'
      highPass.frequency.value = 110
      highPass.Q.value = 0.7
      const lowPass = actx.createBiquadFilter()
      lowPass.type = 'lowpass'
      lowPass.frequency.value = 3800
      lowPass.Q.value = 0.7
      const vadAnalyser = actx.createAnalyser()
      vadAnalyser.fftSize = 1024
      src.connect(highPass)
      highPass.connect(lowPass)
      lowPass.connect(vadAnalyser)
      micAnalyserRef.current = an
      setMicAnalyser(an)

      // MediaRecorder
      const mime = getSupportedMimeType()
      const rec  = new MediaRecorder(stream, mime ? { mimeType: mime } : {})
      recorderRef.current = rec
      chunksRef.current   = []

      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' })
        processAudio(blob)
      }

      rec.start(100)
      setOrbState('listening')
      setSession(true)

      // Estimate noise before speech starts, then freeze that baseline for the
      // turn. A rolling baseline that follows louder sound can prevent silence
      // detection from ever firing in a noisy room.
      const startMs = Date.now()
      let speechStart = null
      let silenceStart = null
      let hasHeardSpeech = false
      let noiseFloor = 0.003
      let speechLevel = 0
      const noiseSamples = []
      const timeBuf = new Float32Array(vadAnalyser.fftSize)

      const updateNoiseFloor = () => {
        if (!noiseSamples.length) return
        const ordered = [...noiseSamples].sort((a, b) => a - b)
        noiseFloor = ordered[Math.floor((ordered.length - 1) * 0.2)]
      }

      const tick = () => {
        if (!micAnalyserRef.current) return
        vadAnalyser.getFloatTimeDomainData(timeBuf)
        let energy = 0
        for (const sample of timeBuf) energy += sample * sample
        const rms = Math.sqrt(energy / timeBuf.length)

        const now = Date.now()
        if (now - startMs >= MAX_RECORD_MS) { stopRecording(); return }

        if (!hasHeardSpeech) {
          noiseSamples.push(rms)
          if (noiseSamples.length > 90) noiseSamples.shift()
          updateNoiseFloor()
        }
        const speechThreshold = Math.max(0.006, noiseFloor * 1.55)

        if (!hasHeardSpeech) {
          if (now - startMs < VAD_CALIBRATION_MS) {
            // Keep recording during calibration so the beginning of speech is
            // preserved, then arm the detector as soon as calibration ends.
            speechStart = rms >= Math.max(0.008, noiseFloor * 1.8) ? (speechStart || now) : null
          } else if (rms >= speechThreshold) {
            speechStart = speechStart || now
            if (now - speechStart >= SPEECH_START_MS) {
              hasHeardSpeech = true
              speechLevel = rms
              setStatusHint('I hear you — pause when you’re done…')
            }
          } else {
            speechStart = null
          }
        } else {
          const silenceThreshold = Math.max(noiseFloor * 1.3, speechLevel * 0.28)
          if (rms < silenceThreshold) {
          silenceStart = silenceStart || now
          if (now - silenceStart >= SILENCE_MS) { stopRecording(); return }
          } else {
            silenceStart = null
            // Track the user's recent speech level, but never let room noise
            // raise the frozen noise baseline during this turn.
            speechLevel = speechLevel * 0.85 + rms * 0.15
          }
        }
        silenceRafRef.current = requestAnimationFrame(tick)
      }
      silenceRafRef.current = requestAnimationFrame(tick)

    } catch (e) {
      const denied = e?.name === 'NotAllowedError'
      setError(
        denied
          ? 'Microphone access was denied — please allow it in your browser settings.'
          : 'Could not access the microphone.',
      )
      setOrbState('idle')
      setStatusHint('')
    }
  }, [apiStatus, processAudio, stopRecording])

  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  useEffect(() => {
    if (apiStatus === 'ready' && pendingListenRef.current) {
      pendingListenRef.current = false
      setStatusHint('')
      startListeningRef.current?.()
    } else if (apiStatus === 'unconfigured' && pendingListenRef.current) {
      pendingListenRef.current = false
      setStatusHint('')
      setError('Add your Groq API key to finish setting up Arisa.')
    }
  }, [apiStatus])

  useEffect(() => {
    if (!desktopMode || !window.arisaDesktop?.onWake) return
    return window.arisaDesktop.onWake(() => {
      if (orbStateRef.current === 'idle') startListening()
    })
  }, [desktopMode, startListening])

  const sendText = async () => {
    const message = textInput.trim()
    if (!message || textBusy) return
    setTextInput('')
    setTextBusy(true)
    setTranscript(message)
    setReply('')
    setError('')
    try {
      const response = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: convIdRef.current, message, desktop_mode: desktopMode }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Chat request failed.')
      convIdRef.current = data.conversation_id
      setReply(data.reply)
      setArisaEmotion(inferArisaEmotion(data.reply))
      await playTTS(data.reply, data.desktop_action === true)
    } catch (e) {
      setError(e.message || 'Could not send that message.')
    } finally {
      setTextBusy(false)
    }
  }

  // ── Orb click handler ─────────────────────────────────────────────────────
  const handleOrbClick = () => {
    const s = orbStateRef.current
    if (s === 'idle') startListening()
    else if (s === 'listening') stopRecording()
    else if (s === 'speaking') {
      cancelSpeechPlayback()
      setSpeakerAnalyser(null)
      if (audioCtxRef.current?.state !== 'closed') audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
      setOrbState('idle')
      setStatusHint('')
      // Keep session alive — user can tap again to continue
    }
  }

  // ── End full session ──────────────────────────────────────────────────────
  const handleEnd = () => {
    pendingListenRef.current = false
    setSession(false)
    _teardown()
    setOrbState('idle')
    setStatusHint('')
  }

  useEffect(() => {
    if (!desktopMode || !window.arisaDesktop?.onHidden) return
    return window.arisaDesktop.onHidden(handleEnd)
  }, [desktopMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived values ────────────────────────────────────────────────────────
  const activeAnalyser = orbState === 'listening'
    ? micAnalyser
    : orbState === 'speaking' ? speakerAnalyser : null

  const stateLabel = {
    idle:      apiStatus === 'checking' ? 'Starting Arisa…' : apiStatus === 'unconfigured' ? 'Add a Groq API key to start' : sessionOn ? 'Tap the orb to continue' : 'Tap the orb to speak',
    listening: 'Listening…',
    thinking:  'Thinking…',
    speaking:  'Speaking…',
  }[orbState] || ''

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="voice-mode">

      {/* Header row */}
      <div className="voice-header">
        <div>
          <div className="voice-kicker">VOICE MODE</div>
          <h2 className="voice-title">Talk with Arisa</h2>
        </div>
        <div className="voice-header-actions">
          {!desktopMode && <button className="voice-pill-btn" onClick={onSwitchToText} title="Switch to text chat">
            <MessageSquare size={14} /> Text mode
          </button>}
          {sessionOn && (
            <button className="voice-pill-btn danger" onClick={handleEnd} title="End voice session">
              <X size={14} /> End session
            </button>
          )}
        </div>
      </div>

      {/* Character stage */}
      <div className="voice-stage">
        <button
          className={`arisa-character-button character-button-${orbState}`}
          onClick={handleOrbClick}
          disabled={orbState === 'idle' && apiStatus !== 'ready'}
          aria-label={stateLabel}
        >
          <ArisaCharacter state={orbState} emotion={arisaEmotion} analyser={activeAnalyser} />
        </button>

        <p className="voice-state-label">{statusHint || stateLabel}</p>

        {orbState === 'listening' && (
          <p className="voice-hint">
            Speak clearly at a natural pace. Arisa waits for a pause, then replies.
          </p>
        )}

        {error && (
          <div className="voice-error-bar" role="alert">
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="Dismiss"><X size={13} /></button>
          </div>
        )}
      </div>

      {/* Last exchange transcript */}
      {(transcript || reply) && (
        <div className="voice-transcript">
          {transcript && (
            <div className="vt-bubble vt-user">
              <span className="vt-label">You said</span>
              <p>{transcript}</p>
            </div>
          )}
          {reply && (
            <div className="vt-bubble vt-arisa">
              <span className="vt-label">Arisa</span>
              <p>{reply}</p>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="voice-controls">
        {orbState === 'idle' && !sessionOn && (
          <button className="voice-start-btn" onClick={startListening} disabled={apiStatus !== 'ready'}>
            <Mic size={18} /> {apiStatus === 'checking' ? 'Starting Arisa…' : apiStatus === 'unconfigured' ? 'Add Groq API key' : 'Start Voice Session'}
          </button>
        )}
        {orbState === 'listening' && (
          <button className="voice-stop-btn" onClick={stopRecording}>
            <MicOff size={18} /> Done speaking
          </button>
        )}
        {orbState === 'speaking' && (
          <button
            className="voice-stop-btn"
            onClick={() => {
              cancelSpeechPlayback()
              setSpeakerAnalyser(null)
              if (audioCtxRef.current?.state !== 'closed') audioCtxRef.current?.close().catch(() => {})
              audioCtxRef.current = null
              setOrbState('idle')
              setStatusHint('')
              if (sessionRef.current) setTimeout(() => { if (sessionRef.current) startListeningRef.current?.() }, 300)
            }}
          >
            <Volume2 size={18} /> Skip response
          </button>
        )}
        {sessionOn && orbState === 'idle' && (
          <button className="voice-continue-btn" onClick={startListening}>
            <Mic size={15} /> Continue speaking
          </button>
        )}
      </div>

      {desktopMode && <form className="voice-text-composer" onSubmit={e => { e.preventDefault(); sendText() }}>
        <textarea rows="1" value={textInput} onChange={e => setTextInput(e.target.value)}
          disabled={apiStatus !== 'ready'}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() } }}
          placeholder="Type to Arisa — replies are spoken aloud" aria-label="Message Arisa by text" />
        <button type="submit" disabled={apiStatus !== 'ready' || !textInput.trim() || textBusy} aria-label="Send message"><Send size={17}/></button>
      </form>}

    </div>
  )
}
