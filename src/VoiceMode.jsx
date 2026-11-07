import { useState, useRef, useEffect, useCallback } from 'react'
import { MessageSquare, Mic, MicOff, Send, Volume2, X } from 'lucide-react'
import ArisaCharacter, { inferArisaEmotion } from './ArisaCharacter'

const API              = '/api'
const SILENCE_MS       = 2000 // Wait two seconds of silence before sending the voice turn
const SPEECH_START_MS  = 200  // Ignore brief clicks before arming silence detection
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

function speakWithSystemVoice(text) {
  const engine = window.speechSynthesis
  if (!engine || !window.SpeechSynthesisUtterance) {
    return Promise.reject(new Error('This device does not provide a built-in speech voice.'))
  }
  engine.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  utterance.rate = 0.96
  utterance.pitch = 1.06
  const voices = engine.getVoices()
  utterance.voice = voices.find(voice => /jenny|zira|aria|ava|emma|michelle|monica|sara|serena|hazel/i.test(voice.name))
    || voices.find(voice => voice.lang?.toLowerCase().startsWith('en-us'))
    || voices.find(voice => voice.lang?.toLowerCase().startsWith('en'))
    || null
  return new Promise((resolve, reject) => {
    utterance.onend = resolve
    utterance.onerror = event => reject(new Error(event.error || 'System speech playback failed.'))
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
  const [arisaEmotion,    setArisaEmotion]    = useState('calm')

  // ── Refs (used inside callbacks to avoid stale closures) ─────────────────
  const orbStateRef    = useRef('idle')
  const sessionRef     = useRef(false)
  const convIdRef      = useRef(null)
  const recorderRef    = useRef(null)
  const chunksRef      = useRef([])
  const streamRef      = useRef(null)
  const audioCtxRef    = useRef(null)
  const micAnalyserRef = useRef(null)
  const silenceRafRef  = useRef(null)
  const audioElRef     = useRef(null)

  /** Sync state + matching ref together. */
  const setOrbState = s => { orbStateRef.current = s; setOrbStateUI(s) }
  const setSession  = v => { sessionRef.current  = v; setSessionOn(v)  }

  // Tear everything down on unmount
  useEffect(() => () => _teardown(), [])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Internal cleanup ──────────────────────────────────────────────────────
  const _teardown = () => {
    if (silenceRafRef.current) cancelAnimationFrame(silenceRafRef.current)
    if (recorderRef.current?.state !== 'inactive') {
      try { recorderRef.current?.stop() } catch {}
    }
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioElRef.current?.pause()
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
  const playTTS = useCallback(async (text, immediate = false) => {
    const spokenText = removeToneLabel(text)
    if (!spokenText) return
    if (immediate) {
      setStatusHint('Speaking…')
      setOrbState('speaking')
      try {
        await speakWithSystemVoice(spokenText)
      } catch (e) {
        setError(`Arisa couldn't speak the confirmation. ${e.message || ''}`.trim())
      } finally {
        setStatusHint('')
        if (sessionRef.current) setTimeout(() => startListening(), 200)
        else setOrbState('idle')
      }
      return
    }
    setStatusHint('Speaking…')
    let objectUrl = null
    try {
      let audio
      if (desktopMode) {
        // Let Chromium play the MP3 response as it streams from Edge TTS. The
        // previous POST/blob flow waited for the entire reply audio first.
        const streamUrl = `${API}/arisa/tts/stream?text=${encodeURIComponent(spokenText)}`
        audio = new Audio(streamUrl)
        audio.preload = 'auto'
      } else {
        const res = await fetch(`${API}/arisa/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spokenText }),
        })
        if (!res.ok) {
          const body = await res.text()
          let detail
          try { detail = JSON.parse(body)?.detail } catch {}
          throw new Error(detail || body?.slice(0, 180) || `Speech generation failed (HTTP ${res.status}).`)
        }

        const blob = await res.blob()
        if (!blob.size) throw new Error('The speech API returned an empty audio file.')
        objectUrl = URL.createObjectURL(blob)
        audio = new Audio(objectUrl)
      }
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
        audio.onended = resolve
        audio.onerror = () => reject(new Error('The generated audio could not be played.'))
        audio.play().catch(reject)
      })
    } catch (e) {
      try {
        audioElRef.current?.pause()
        if (audioCtxRef.current?.state !== 'closed') await audioCtxRef.current?.close()
        audioCtxRef.current = null
        setSpeakerAnalyser(null)
        setStatusHint('Speaking with your device voice…')
        setOrbState('speaking')
        await speakWithSystemVoice(spokenText)
      } catch (fallbackError) {
        setError(`Arisa could not speak. ${e.message || 'TTS API failed.'} ${fallbackError.message || ''}`.trim())
      }
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      audioElRef.current = null
      setSpeakerAnalyser(null)
      setStatusHint('')
      if (audioCtxRef.current?.state !== 'closed') {
        try { await audioCtxRef.current.close() } catch {}
      }
      audioCtxRef.current = null
      // Auto-loop: jump straight back into listening if the session is still on
      if (sessionRef.current) {
        setTimeout(() => startListening(), 400)
      } else {
        setOrbState('idle')
      }
    }
  }, [desktopMode])  // startListening referenced via closure below — hoisted after definition

  // ── Process audio blob → backend ──────────────────────────────────────────
  const processAudio = useCallback(async blob => {
    if (blob.size < MIN_BLOB_BYTES) { setOrbState('idle'); return }
    setOrbState('thinking')
    setMicAnalyser(null)
    setError('')
    setStatusHint('Processing…')

    try {
      const fd = new FormData()
      fd.append('file', blob, 'voice.webm')
      if (convIdRef.current) fd.append('conversation_id', convIdRef.current)
      fd.append('desktop_mode', String(desktopMode))

      const res = await fetch(`${API}/arisa/voice`, { method: 'POST', body: fd })
      const data = await readApiResult(res, 'Voice API request')
      setTranscript(data.user_transcript || '')
      setReply(data.arisa_reply || '')
      convIdRef.current = data.conversation_id
      setArisaEmotion(inferArisaEmotion(data.arisa_reply || ''))
      await playTTS(data.arisa_reply || '', data.desktop_action === true)
    } catch (e) {
      setError(e.message === 'Failed to fetch'
        ? 'Could not reach the voice API. Make sure Arisa’s backend is running, then try again.'
        : e.message || 'Voice request failed.')
      setOrbState('idle')
      setStatusHint('')
    }
  }, [desktopMode, playTTS])

  // ── Start listening ───────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    if (orbStateRef.current === 'listening') return
    setError('')
    setStatusHint('Waiting for you to speak…')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      streamRef.current = stream

      // Mic audio analysis (for orb visualiser + silence detection)
      const actx = new AudioContext()
      audioCtxRef.current = actx
      const src  = actx.createMediaStreamSource(stream)
      const an   = actx.createAnalyser(); an.fftSize = 512
      src.connect(an)
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

      // Adapt the voice gate to room noise so a steady fan or mic hiss does not
      // keep a turn open forever, while silence between words does not end it.
      const startMs = Date.now()
      let speechStart = null
      let silenceStart = null
      let hasHeardSpeech = false
      let noiseFloor = 0.003
      const energySamples = []
      const timeBuf = new Float32Array(an.fftSize)

      const tick = () => {
        if (!micAnalyserRef.current) return
        an.getFloatTimeDomainData(timeBuf)
        let energy = 0
        for (const sample of timeBuf) energy += sample * sample
        const rms = Math.sqrt(energy / timeBuf.length)

        const now = Date.now()
        if (now - startMs >= MAX_RECORD_MS) { stopRecording(); return }

        energySamples.push(rms)
        if (energySamples.length > 60) energySamples.shift()
        if (energySamples.length >= 8) {
          const ordered = [...energySamples].sort((a, b) => a - b)
          noiseFloor = ordered[Math.floor((ordered.length - 1) * 0.2)]
        }
        const speechThreshold = Math.max(0.008, noiseFloor * 2.0)
        const silenceThreshold = Math.max(0.005, noiseFloor * 1.35)

        // Give the mic a short calibration window; samples still record while
        // this runs, so speech at the start is not lost.
        if (!hasHeardSpeech && now - startMs < 350) {
          silenceRafRef.current = requestAnimationFrame(tick)
          return
        }

        if (!hasHeardSpeech) {
          if (rms >= speechThreshold) {
            speechStart = speechStart || now
            if (now - speechStart >= SPEECH_START_MS) {
              hasHeardSpeech = true
              setStatusHint('I hear you — pause when you’re done…')
            }
          } else {
            speechStart = null
          }
        } else if (rms < silenceThreshold) {
          silenceStart = silenceStart || now
          if (now - silenceStart >= SILENCE_MS) { stopRecording(); return }
        } else {
          silenceStart = null
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
  }, [processAudio, stopRecording])

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
      audioElRef.current?.pause()
      setSpeakerAnalyser(null)
      setOrbState('idle')
      setStatusHint('')
      // Keep session alive — user can tap again to continue
    }
  }

  // ── End full session ──────────────────────────────────────────────────────
  const handleEnd = () => {
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
    idle:      sessionOn ? 'Tap the orb to continue' : 'Tap the orb to speak',
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
          <button className="voice-start-btn" onClick={startListening}>
            <Mic size={18} /> Start Voice Session
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
              audioElRef.current?.pause()
              setSpeakerAnalyser(null)
              setOrbState('idle')
              setStatusHint('')
              if (sessionRef.current) setTimeout(() => startListening(), 300)
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
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() } }}
          placeholder="Type to Arisa — replies are spoken aloud" aria-label="Message Arisa by text" />
        <button type="submit" disabled={!textInput.trim() || textBusy} aria-label="Send message"><Send size={17}/></button>
      </form>}

    </div>
  )
}
