import { useState, useRef, useEffect, useCallback } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, MessageSquare, Mic, MicOff, RefreshCw, Send, Trash2, Volume2, X } from 'lucide-react'
import ArisaCharacter, { inferArisaEmotion } from './ArisaCharacter'

const API              = '/api'
const SILENCE_MS       = 550  // Begin processing sooner after a natural pause
const SPEECH_START_MS  = 150  // Reject brief clicks while arming quickly
const VAD_CALIBRATION_MS = 300 // Establish the room's noise level before adapting the voice gate

function wakeDiagnosticSummary(event) {
  if (event.stage === 'listener_ready') return `Microphone stream open: ${event.device_name || 'default input'} · ${event.sample_rate || 16000} Hz`
  if (event.stage === 'partial_transcript') return `Vosk is hearing: “${event.transcript || ''}”`
  if (event.stage === 'phrase_result') {
    if (event.accepted) return `Vosk accepted “${event.transcript}” as “${event.normalized}”.`
    if (event.reason === 'phrase_not_authorized') return `Vosk heard “${event.transcript}”, but it didn’t match an allowed phrase.`
    if (event.reason === 'confidence_below_threshold') return `Vosk heard “${event.transcript}”, but confidence was too low (${event.observed_min_confidence}; needs ${event.required_confidence}).`
    if (event.reason === 'word_confidence_unavailable') return `Vosk heard “${event.transcript}”, but did not provide word-confidence data.`
    return `Vosk could not recognize a complete phrase (${event.reason || 'unknown reason'}).`
  }
  const summaries = {
    listener_process_started: 'Starting the local wake listener.',
    listener_paused: event.message || 'The wake listener paused while Arisa uses the conversation microphone.',
    wake_bridge_listening: 'Electron wake bridge is listening on this PC.',
    wake_request_sending: `Authorized phrase matched; notifying Electron${event.transcript ? ` (“${event.transcript}”)` : ''}.`,
    wake_request_response: `The local Electron bridge responded with HTTP ${event.status_code}.`,
    wake_request_failed: `Could not reach Electron: ${event.error || 'unknown local connection error'}`,
    wake_bridge_received: 'Electron received the wake request.',
    wake_bridge_error: `Electron wake bridge error: ${event.error || event.message || 'unknown error'}`,
    wake_window_unavailable: 'Electron received the phrase but has no available app window.',
    wake_duplicate_suppressed: 'A repeated wake request was suppressed.',
    wake_window_show_requested: `Electron requested the window to show${event.visible ? ' (visible)' : ''}.`,
    wake_renderer_ready: 'The voice interface is ready to receive wake events.',
    renderer_notified: `Electron sent the wake event to the voice interface (attempt ${event.attempt || 1}).`,
    renderer_ack_retry: `The voice interface did not acknowledge yet; retrying (attempt ${event.attempt || 2}).`,
    renderer_ack_timeout: event.message || 'The voice interface did not acknowledge the wake event.',
    renderer_send_failed: `Electron could not send the wake event: ${event.error || 'voice window unavailable'}`,
    wake_renderer_acknowledged: 'The voice interface received the wake event.',
    wake_renderer_received: 'Arisa’s voice screen received the wake event.',
    wake_renderer_busy: 'The voice screen received the wake event but was already busy.',
    voice_start_waiting_for_api: 'Waiting for Arisa’s API before starting the microphone.',
    voice_api_unconfigured: 'The voice screen cannot start listening until the AI API is configured.',
    voice_microphone_acquired: 'Arisa’s conversation microphone opened successfully.',
    voice_listening_started: 'Arisa is now ready to hear your next instruction.',
    voice_start_failed: `Arisa could not start the conversation microphone: ${event.error || 'check microphone access'}`,
    listener_process_exited: event.message || 'The local wake listener exited.',
    listener_stderr: `Wake listener message: ${event.message || ''}`,
    listener_diagnostic_parse_error: event.message || 'Could not read a listener diagnostic event.',
    audio_overflow: event.message || 'The microphone input buffer overflowed.',
    wake_bridge_invalid_payload: event.message || 'Electron rejected an invalid local wake request.',
  }
  return summaries[event.stage] || `Wake pipeline: ${String(event.stage || 'unknown').replaceAll('_', ' ')}`
}
const MAX_RECORD_MS    = 300000 // Safety limit for an unattended recording (5 minutes)
const MIN_BLOB_BYTES   = 1500  // Ignore clicks while retaining short, quiet utterances
const INTERRUPTION_KEYWORDS = new Set(['stop', 'enough', 'wait'])
const INTERRUPTION_SILENCE_MS = 500
const INTERRUPTION_CALIBRATION_MS = 120
const INTERRUPTION_MAX_UTTERANCE_MS = 2200
const INTERRUPTION_MIN_BLOB_BYTES = 650

function normalizeInterruptionKeyword(text = '') {
  const words = String(text).normalize('NFKC').toLowerCase().match(/[a-z]+/g) || []
  return words.length && words.every(word => INTERRUPTION_KEYWORDS.has(word)) ? words[0] : null
}

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
  const [wakeStatus,      setWakeStatus]      = useState(null)
  const [wakeSettingsBusy,setWakeSettingsBusy]= useState(false)
  const [wakeDiagnosticsOpen, setWakeDiagnosticsOpen] = useState(false)
  const [computerSettings, setComputerSettings] = useState({ enabled: false, screenVision: false, sessionToken: '' })

  // ── Refs (used inside callbacks to avoid stale closures) ─────────────────
  const orbStateRef    = useRef('idle')
  const sessionRef     = useRef(false)
  const convIdRef      = useRef(null)
  const recorderRef    = useRef(null)
  const chunksRef      = useRef([])
  const speechPlaybackRef = useRef(null)
  const streamedReplyCancelRef = useRef(null)
  const interruptionGenerationRef = useRef(0)
  const interruptionStreamRef = useRef(null)
  const interruptionContextRef = useRef(null)
  const interruptionAnalyserRef = useRef(null)
  const interruptionRafRef = useRef(null)
  const interruptionRecorderRef = useRef(null)
  const interruptionRequestRef = useRef(null)
  const interruptionInFlightRef = useRef(false)
  const interruptionTriggeredRef = useRef(false)
  const computerTaskRef = useRef('')
  const startListeningRef = useRef(null)
  const pendingListenRef = useRef(false)
  const pendingListenTriggerRef = useRef('user')
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

  useEffect(() => {
    if (!desktopMode || !window.arisaDesktop?.getWakeStatus) return
    let stopped = false
    const unsubscribe = window.arisaDesktop.onWakeStatus?.(status => {
      if (!stopped) setWakeStatus(status)
    })
    window.arisaDesktop.getWakeStatus()
      .then(status => { if (!stopped) setWakeStatus(status) })
      .catch(error => {
        if (!stopped) setWakeStatus({ enabled: false, runAtLogin: false, state: 'error', error: error.message })
      })
    return () => { stopped = true; unsubscribe?.() }
  }, [desktopMode])

  useEffect(() => {
    if (!desktopMode || !window.arisaDesktop?.getComputerSettings) return
    window.arisaDesktop.getComputerSettings().then(setComputerSettings).catch(() => {})
  }, [desktopMode])

  const updateComputerSettings = async update => {
    setWakeSettingsBusy(true)
    try {
      if (update.enabled === false && computerTaskRef.current) cancelComputerTask()
      const settings = await window.arisaDesktop?.setComputerSettings?.(update)
      if (settings) setComputerSettings(settings)
    } catch (error) {
      setError(error.message || 'Could not update computer-use permissions.')
    } finally {
      setWakeSettingsBusy(false)
    }
  }

  const updateWakeSetting = async (setting, enabled) => {
    setWakeSettingsBusy(true)
    try {
      const method = setting === 'enabled' ? 'setWakeEnabled' : 'setWakeStartup'
      const status = await window.arisaDesktop?.[method]?.(enabled)
      if (status) setWakeStatus(status)
    } catch (error) {
      setWakeStatus(current => ({ ...current, state: 'error', error: error.message || 'Could not update the voice activation setting.' }))
    } finally {
      setWakeSettingsBusy(false)
    }
  }

  const retryWakeListener = async () => {
    setWakeSettingsBusy(true)
    try {
      const status = await window.arisaDesktop?.retryWakeListener?.()
      if (status) setWakeStatus(status)
    } catch (error) {
      setWakeStatus(current => ({ ...current, state: 'error', error: error.message || 'Could not restart the wake listener.' }))
    } finally {
      setWakeSettingsBusy(false)
    }
  }

  const clearWakeDiagnostics = async () => {
    try {
      const status = await window.arisaDesktop?.clearWakeDiagnostics?.()
      if (status) setWakeStatus(status)
    } catch (error) {
      setWakeStatus(current => ({ ...current, error: error.message || 'Could not clear wake diagnostics.' }))
    }
  }

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

  const cancelComputerTask = () => {
    const taskId = computerTaskRef.current
    if (!taskId) return
    const token = computerSettings.sessionToken
    if (token) fetch(`${API}/computer/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Arisa-Computer-Token': token },
      body: JSON.stringify({ task_id: taskId }),
      keepalive: true,
    }).catch(() => {})
    computerTaskRef.current = ''
    cancelSpeechPlayback()
    setOrbState('idle')
    setStatusHint('')
    setError('Computer task cancelled. An action already in progress may have just completed.')
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
  const playTTS = useCallback(async (text, immediate = false, { streamChunk = false, preparedAudio = null } = {}) => {
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
    let source = null
    let analyser = null
    let settleAudio = null
    playback.cancel = () => {
      playback.cancelled = true
      audio?.pause()
      if (audio) {
        audio.currentTime = 0
        audio.removeAttribute('src')
        audio.load()
      }
      settleAudio?.()
    }
    speechPlaybackRef.current = playback
    try {
      // Streamed replies can prefetch the next chunk while the current chunk plays.
      const streamUrl = `${API}/arisa/tts/stream?text=${encodeURIComponent(spokenText)}`
      audio = preparedAudio || new Audio(streamUrl)
      audio.preload = 'auto'
      audioElRef.current = audio

      // Reuse one context through a streamed reply instead of rebuilding it at each period.
      const AudioContextType = window.AudioContext || window.webkitAudioContext
      let actx = audioCtxRef.current
      if (!actx || actx.state === 'closed') {
        actx = new AudioContextType()
        audioCtxRef.current = actx
      }
      if (actx.state === 'suspended') await actx.resume()
      if (playback.cancelled) return
      source = actx.createMediaElementSource(audio)
      analyser = actx.createAnalyser(); analyser.fftSize = 1024
      source.connect(analyser); analyser.connect(actx.destination)
      setSpeakerAnalyser(analyser)
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
        settleAudio = () => settle()
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
        if (!streamChunk && audioCtxRef.current?.state !== 'closed') await audioCtxRef.current?.close()
        if (!streamChunk) audioCtxRef.current = null
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
      try { source?.disconnect() } catch {}
      try { analyser?.disconnect() } catch {}
      if (!streamChunk) setSpeakerAnalyser(null)
      if (!streamChunk && audioCtxRef.current?.state !== 'closed') {
        try { await audioCtxRef.current.close() } catch {}
      }
      if (!streamChunk) audioCtxRef.current = null
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
      const context = audioCtxRef.current
      audioCtxRef.current = null
      if (context && context.state !== 'closed') context.close().catch(() => {})
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
      for (const item of speechQueue) {
        if (!item.audio) continue
        item.audio.pause()
        item.audio.removeAttribute('src')
        item.audio.load()
      }
      speechQueue.length = 0
      controller.abort()
      resolveSpeechComplete()
    }
    streamedReplyCancelRef.current = cancelStreamedResponse

    const prefetchNextSpeech = () => {
      const item = speechQueue[0]
      if (!speechDraining || !item || item.audio) return
      const streamUrl = `${API}/arisa/tts/stream?text=${encodeURIComponent(removeToneLabel(item.text))}`
      item.audio = new Audio(streamUrl)
      item.audio.preload = 'auto'
      item.audio.load()
    }

    const drainSpeechQueue = async () => {
      if (speechDraining) return
      speechDraining = true
      while (speechQueue.length && !cancelled) {
        const item = speechQueue.shift()
        prefetchNextSpeech()
        await playTTS(item.text, false, { streamChunk: true, preparedAudio: item.audio })
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
        speechQueue.push({ text: sentence, audio: null })
        prefetchNextSpeech()
        void drainSpeechQueue()
      } else if (event === 'done') {
        responseFinished = true
        const finalReply = payload.reply || partialReply
        setReply(finalReply)
        setArisaEmotion(inferArisaEmotion(finalReply))
        if (!receivedSentence && finalReply) {
          speechQueue.push({ text: finalReply, audio: null })
          prefetchNextSpeech()
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
      fd.append('computer_use', String(computerSettings.enabled))
      fd.append('screen_vision', String(computerSettings.enabled && computerSettings.screenVision))
      const useStream = !computerSettings.enabled
      fd.append('stream_response', String(useStream))
      const taskId = computerSettings.enabled ? window.crypto.randomUUID() : ''
      if (taskId) {
        computerTaskRef.current = taskId
        fd.append('task_id', taskId)
      }

      const headers = computerSettings.sessionToken ? { 'X-Arisa-Computer-Token': computerSettings.sessionToken } : {}
      const res = await fetch(`${API}/arisa/voice`, { method: 'POST', headers, body: fd, signal: controller.signal })
      if (!res.ok) throw new Error((await readApiResult(res, 'Voice API request')).detail || 'Voice API request failed.')
      if (!useStream) {
        const data = await res.json()
        setTranscript(data.user_transcript || '')
        convIdRef.current = data.conversation_id || convIdRef.current
        const finalReply = data.arisa_reply || 'I could not complete that computer task.'
        setReply(finalReply)
        setArisaEmotion(inferArisaEmotion(finalReply))
        responseFinished = true
        speechQueue.push({ text: finalReply, audio: null })
        void drainSpeechQueue()
        await speechComplete
        if (computerTaskRef.current === taskId) computerTaskRef.current = ''
        return
      }
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
      if (computerTaskRef.current === taskId) computerTaskRef.current = ''
    } catch (e) {
      if (!cancelled) {
        cancelSpeechPlayback()
        setError(e.message === 'Failed to fetch'
          ? 'Could not reach the voice API. Make sure Arisa’s backend is running, then try again.'
          : e.message || 'Voice request failed.')
        setSpeakerAnalyser(null)
        setOrbState('idle')
        setStatusHint('')
        if (audioCtxRef.current?.state !== 'closed') audioCtxRef.current?.close().catch(() => {})
        audioCtxRef.current = null
      }
      computerTaskRef.current = ''
    }
  }, [desktopMode, playTTS, computerSettings])

  // ── Start listening ───────────────────────────────────────────────────────
  const startListening = useCallback(async (trigger = 'user') => {
    if (orbStateRef.current === 'listening') {
      if (trigger === 'wake') window.arisaDesktop?.reportWakeDiagnostic?.('wake_renderer_busy')
      return
    }
    if (desktopMode) window.arisaDesktop?.setVoiceState?.('starting')
    if (apiStatus === 'checking') {
      pendingListenRef.current = true
      pendingListenTriggerRef.current = trigger
      setError('')
      setStatusHint('Arisa is starting…')
      if (trigger === 'wake') window.arisaDesktop?.reportWakeDiagnostic?.('voice_start_waiting_for_api')
      return
    }
    if (apiStatus === 'unconfigured') {
      pendingListenRef.current = false
      setStatusHint('')
      setError('Add your Groq API key to finish setting up Arisa.')
      if (trigger === 'wake') window.arisaDesktop?.reportWakeDiagnostic?.('voice_api_unconfigured')
      if (desktopMode) window.arisaDesktop?.setVoiceState?.('idle')
      return
    }
    pendingListenRef.current = false
    pendingListenTriggerRef.current = 'user'
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
      if (trigger === 'wake') window.arisaDesktop?.reportWakeDiagnostic?.('voice_microphone_acquired')

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
      if (trigger === 'wake') window.arisaDesktop?.reportWakeDiagnostic?.('voice_listening_started')

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
      if (trigger === 'wake') {
        window.arisaDesktop?.reportWakeDiagnostic?.('voice_start_failed', {
          error: denied ? 'Microphone permission was denied.' : `${e?.name || 'Error'}: ${e?.message || 'microphone access failed'}`,
        })
      }
      setError(
        denied
          ? 'Microphone access was denied — please allow it in your browser settings.'
          : 'Could not access the microphone.',
      )
      setOrbState('idle')
      setStatusHint('')
    }
  }, [apiStatus, desktopMode, processAudio, stopRecording])

  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  // Voice activity only opens a short STT check. It never stops playback unless
  // the complete transcription consists only of authorized interruption words.
  useEffect(() => {
    if (orbState !== 'speaking' || !sessionOn) return

    const generation = ++interruptionGenerationRef.current
    let disposed = false
    let stream = null
    let context = null
    let analyser = null
    let source = null
    let highPass = null
    let lowPass = null
    let activeRecorder = null
    let captureChunks = []
    let captureStartedAt = 0
    let hasSpeech = false
    let speechStartedAt = 0
    let silenceStartedAt = 0
    let discardUntilSilence = false
    let noiseFloor = 0.003
    let noiseSamples = []
    const startedAt = Date.now()
    const timeBuffer = new Float32Array(1024)

    const current = () => !disposed && generation === interruptionGenerationRef.current
    const cleanup = () => {
      if (disposed) return
      disposed = true
      if (generation === interruptionGenerationRef.current) interruptionGenerationRef.current += 1
      if (interruptionRafRef.current) cancelAnimationFrame(interruptionRafRef.current)
      interruptionRafRef.current = null
      interruptionRequestRef.current?.abort()
      interruptionRequestRef.current = null
      if (activeRecorder?.state === 'recording') {
        activeRecorder.onstop = null
        try { activeRecorder.stop() } catch {}
      }
      if (interruptionRecorderRef.current === activeRecorder) interruptionRecorderRef.current = null
      stream?.getTracks().forEach(track => track.stop())
      if (interruptionStreamRef.current === stream) interruptionStreamRef.current = null
      try { source?.disconnect() } catch {}
      try { highPass?.disconnect() } catch {}
      try { lowPass?.disconnect() } catch {}
      if (context && context.state !== 'closed') context.close().catch(() => {})
      if (interruptionContextRef.current === context) interruptionContextRef.current = null
      interruptionAnalyserRef.current = null
      interruptionInFlightRef.current = false
    }

    const transcribeCapture = async (blob, recorderGeneration) => {
      if (!current() || blob.size < INTERRUPTION_MIN_BLOB_BYTES) {
        interruptionInFlightRef.current = false
        return
      }
      const controller = new AbortController()
      interruptionRequestRef.current = controller
      try {
        const form = new FormData()
        form.append('file', blob, 'interruption.webm')
        const response = await fetch(`${API}/arisa/interrupt-keyword`, {
          method: 'POST', body: form, signal: controller.signal,
        })
        if (!response.ok) return
        const result = await response.json()
        const keyword = normalizeInterruptionKeyword(result.keyword || '')
        if (
          keyword && current() && recorderGeneration === interruptionGenerationRef.current &&
          sessionRef.current && orbStateRef.current === 'speaking' && !interruptionTriggeredRef.current
        ) {
          interruptionTriggeredRef.current = true
          cleanup()
          cancelSpeechPlayback()
          const voiceContext = audioCtxRef.current
          audioCtxRef.current = null
          if (voiceContext && voiceContext.state !== 'closed') voiceContext.close().catch(() => {})
          setStatusHint('Interrupted — listening…')
          setOrbState('idle')
          setTimeout(() => {
            if (sessionRef.current) startListeningRef.current?.()
          }, 120)
        }
      } catch {
        // Network or recognition uncertainty must leave the current speech alone.
      } finally {
        if (interruptionRequestRef.current === controller) interruptionRequestRef.current = null
        if (current()) interruptionInFlightRef.current = false
      }
    }

    const startCapture = () => {
      if (!stream || activeRecorder || interruptionInFlightRef.current) return
      try {
        const mime = getSupportedMimeType()
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {})
        activeRecorder = recorder
        interruptionRecorderRef.current = recorder
        captureChunks = []
        recorder.ondataavailable = event => {
          if (event.data?.size) captureChunks.push(event.data)
        }
        recorder.onstop = () => {
          if (interruptionRecorderRef.current === recorder) interruptionRecorderRef.current = null
          if (activeRecorder === recorder) activeRecorder = null
          if (discardUntilSilence || !current()) {
            interruptionInFlightRef.current = false
            return
          }
          const blob = new Blob(captureChunks, { type: mime || 'audio/webm' })
          void transcribeCapture(blob, generation)
        }
        captureStartedAt = Date.now()
        recorder.start(100)
      } catch {
        interruptionInFlightRef.current = false
      }
    }

    const tick = () => {
      if (!current()) return
      if (!sessionRef.current || orbStateRef.current !== 'speaking') {
        cleanup()
        return
      }
      if (!analyser) return
      analyser.getFloatTimeDomainData(timeBuffer)
      let energy = 0
      for (const sample of timeBuffer) energy += sample * sample
      const rms = Math.sqrt(energy / timeBuffer.length)
      const now = Date.now()
      const threshold = Math.max(0.007, noiseFloor * 1.8)

      if (interruptionInFlightRef.current) {
        interruptionRafRef.current = requestAnimationFrame(tick)
        return
      }

      if (discardUntilSilence) {
        if (rms < threshold * 0.7) {
          silenceStartedAt ||= now
          if (now - silenceStartedAt >= INTERRUPTION_SILENCE_MS) {
            discardUntilSilence = false
            hasSpeech = false
            silenceStartedAt = 0
          }
        } else silenceStartedAt = 0
      } else if (!hasSpeech) {
        if (now - startedAt < INTERRUPTION_CALIBRATION_MS) {
          noiseSamples.push(rms)
          if (noiseSamples.length > 45) noiseSamples.shift()
          const ordered = [...noiseSamples].sort((a, b) => a - b)
          if (ordered.length) noiseFloor = ordered[Math.floor((ordered.length - 1) * 0.2)]
        } else if (rms >= threshold) {
          speechStartedAt ||= now
          if (now - speechStartedAt >= 75) {
            hasSpeech = true
            silenceStartedAt = 0
            startCapture()
          }
        } else speechStartedAt = 0
      } else if (now - captureStartedAt >= INTERRUPTION_MAX_UTTERANCE_MS) {
        discardUntilSilence = true
        interruptionInFlightRef.current = true
        if (activeRecorder?.state === 'recording') activeRecorder.stop()
      } else if (rms < threshold * 0.7) {
        silenceStartedAt ||= now
        if (now - silenceStartedAt >= INTERRUPTION_SILENCE_MS) {
          hasSpeech = false
          speechStartedAt = 0
          silenceStartedAt = 0
          if (activeRecorder?.state === 'recording') {
            interruptionInFlightRef.current = true
            activeRecorder.stop()
          }
        }
      } else silenceStartedAt = 0

      interruptionRafRef.current = requestAnimationFrame(tick)
    }

    const setup = async () => {
      try {
        const supported = navigator.mediaDevices.getSupportedConstraints?.() || {}
        const audio = {
          echoCancellation: supported.echoCancellation ? { ideal: true } : true,
          noiseSuppression: supported.noiseSuppression ? { ideal: true } : true,
          autoGainControl: supported.autoGainControl ? { ideal: true } : true,
        }
        if (supported.channelCount) audio.channelCount = { ideal: 1 }
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
        if (!current() || !sessionRef.current || orbStateRef.current !== 'speaking') {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        interruptionStreamRef.current = stream
        const AudioContextType = window.AudioContext || window.webkitAudioContext
        context = new AudioContextType()
        interruptionContextRef.current = context
        if (context.state === 'suspended') await context.resume()
        if (!current()) return
        source = context.createMediaStreamSource(stream)
        highPass = context.createBiquadFilter()
        highPass.type = 'highpass'; highPass.frequency.value = 110
        lowPass = context.createBiquadFilter()
        lowPass.type = 'lowpass'; lowPass.frequency.value = 3800
        analyser = context.createAnalyser(); analyser.fftSize = 1024
        source.connect(highPass); highPass.connect(lowPass); lowPass.connect(analyser)
        interruptionAnalyserRef.current = analyser
        interruptionRafRef.current = requestAnimationFrame(tick)
      } catch {
        // If the mic or browser recognition path is unavailable, keep speaking normally.
        cleanup()
      }
    }

    interruptionTriggeredRef.current = false
    void setup()
    return cleanup
  }, [orbState, sessionOn])

  useEffect(() => {
    if (apiStatus === 'ready' && pendingListenRef.current) {
      pendingListenRef.current = false
      setStatusHint('')
      const trigger = pendingListenTriggerRef.current
      pendingListenTriggerRef.current = 'user'
      startListeningRef.current?.(trigger)
    } else if (apiStatus === 'unconfigured' && pendingListenRef.current) {
      pendingListenRef.current = false
      setStatusHint('')
      setError('Add your Groq API key to finish setting up Arisa.')
      if (pendingListenTriggerRef.current === 'wake') window.arisaDesktop?.reportWakeDiagnostic?.('voice_api_unconfigured')
      pendingListenTriggerRef.current = 'user'
    }
  }, [apiStatus])

  useEffect(() => {
    if (!desktopMode || !window.arisaDesktop?.onWake) return
    return window.arisaDesktop.onWake(request => {
      window.arisaDesktop?.reportWakeDiagnostic?.('wake_renderer_received', {
        request_id: request?.request_id,
        transcript: request?.transcript,
      })
      if (orbStateRef.current === 'idle') startListening('wake')
      else window.arisaDesktop?.reportWakeDiagnostic?.('wake_renderer_busy')
    })
  }, [desktopMode, startListening])

  useEffect(() => {
    if (!desktopMode) return
    const voiceState = sessionOn && orbState === 'idle' ? 'session-idle' : orbState
    window.arisaDesktop?.setVoiceState?.(voiceState)
  }, [desktopMode, orbState, sessionOn])

  const sendText = async () => {
    const message = textInput.trim()
    if (!message || textBusy) return
    setTextInput('')
    setTextBusy(true)
    setTranscript(message)
    setReply('')
    setError('')
    try {
      const taskId = computerSettings.enabled ? window.crypto.randomUUID() : ''
      if (taskId) computerTaskRef.current = taskId
      const response = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(computerSettings.sessionToken ? { 'X-Arisa-Computer-Token': computerSettings.sessionToken } : {}) },
        body: JSON.stringify({ conversation_id: convIdRef.current, message, desktop_mode: desktopMode, computer_use: computerSettings.enabled, screen_vision: computerSettings.enabled && computerSettings.screenVision, task_id: taskId || null }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Chat request failed.')
      if (taskId && computerTaskRef.current !== taskId) return
      convIdRef.current = data.conversation_id
      setReply(data.reply)
      setArisaEmotion(inferArisaEmotion(data.reply))
      await playTTS(data.reply, data.desktop_action === true)
    } catch (e) {
      setError(e.message || 'Could not send that message.')
    } finally {
      computerTaskRef.current = ''
      setTextBusy(false)
    }
  }

  // ── Character click handler ────────────────────────────────────────────────
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
    idle:      apiStatus === 'checking' ? 'Starting Arisa…' : apiStatus === 'unconfigured' ? 'Add a Groq API key to start' : sessionOn ? 'Tap Arisa to continue' : 'Tap Arisa to speak',
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

        <p className={`voice-state-label voice-state-${orbState}`} role="status" aria-live="polite">{statusHint || stateLabel}</p>

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
        {orbState === 'thinking' && computerSettings.enabled && (
          <button className="voice-stop-btn" onClick={cancelComputerTask}>
            <X size={17} /> Cancel computer task
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
        {textBusy && computerSettings.enabled && <button type="button" className="computer-cancel-inline" onClick={cancelComputerTask}>Cancel task</button>}
      </form>}

      {desktopMode && wakeStatus && <section className="voice-activation-settings" aria-label="Voice activation settings">
        <div className="wake-settings-heading">
          <div className="wake-settings-icon"><Mic size={16}/></div>
          <div className="wake-settings-title"><strong>Voice activation</strong><span>Manage hands-free access to Arisa</span></div>
          <span className={`wake-state-badge ${wakeStatus.state}`} role="status">
            <i />{wakeStatus.state === 'listening' ? 'Listening locally' : wakeStatus.state === 'starting' ? 'Starting' : wakeStatus.state === 'retrying' ? 'Retrying' : wakeStatus.state === 'paused' ? 'Paused during voice session' : wakeStatus.state === 'error' ? 'Listener error' : 'Off'}
          </span>
        </div>
        <div className="wake-setting-row">
          <div><strong>Listen for wake phrases</strong><span>“Wake up Arisa,” “Arisa open,” or “I need you Arisa.”</span></div>
          <button type="button" className={`wake-switch ${wakeStatus.enabled ? 'enabled' : ''}`} role="switch" aria-checked={!!wakeStatus.enabled} aria-label="Enable voice activation" disabled={wakeSettingsBusy} onClick={() => updateWakeSetting('enabled', !wakeStatus.enabled)}><i /></button>
        </div>
        <div className="wake-setting-row startup-row">
          <div><strong>Start Arisa with Windows</strong><span>Keep wake phrases available after you sign in.</span></div>
          <button type="button" className={`wake-switch ${wakeStatus.runAtLogin ? 'enabled' : ''}`} role="switch" aria-checked={!!wakeStatus.runAtLogin} aria-label="Start Arisa with Windows" disabled={wakeSettingsBusy} onClick={() => updateWakeSetting('startup', !wakeStatus.runAtLogin)}><i /></button>
        </div>
        <div className="wake-setting-row startup-row">
          <div><strong>Allow computer interaction</strong><span>For tasks you request, Arisa sends the active window title and accessible control text to Groq so it can choose actions. Close sensitive windows first.</span></div>
          <button type="button" className={`wake-switch ${computerSettings.enabled ? 'enabled' : ''}`} role="switch" aria-checked={computerSettings.enabled} aria-label="Allow computer interaction" disabled={wakeSettingsBusy} onClick={() => updateComputerSettings({ enabled: !computerSettings.enabled, screenVision: !computerSettings.enabled && computerSettings.screenVision })}><i /></button>
        </div>
        <div className="wake-setting-row startup-row">
          <div><strong>Share requested screenshots with Groq</strong><span>Also send a screenshot when visual detail is needed. It may contain private information; close sensitive windows first.</span></div>
          <button type="button" className={`wake-switch ${computerSettings.screenVision ? 'enabled' : ''}`} role="switch" aria-checked={computerSettings.screenVision} aria-label="Allow screenshot sharing" disabled={wakeSettingsBusy || !computerSettings.enabled} onClick={() => updateComputerSettings({ enabled: true, screenVision: !computerSettings.screenVision })}><i /></button>
        </div>
        <p className="wake-private-note"><CheckCircle2 size={13}/> Both permissions are off by default. Arisa uses screen information only for tasks you request; screenshot images require the second switch.</p>
        {wakeStatus.error && <div className="wake-listener-error" role="alert"><AlertCircle size={15}/><span>{wakeStatus.error}</span></div>}
        {wakeStatus.startupError && <div className="wake-listener-error" role="alert"><AlertCircle size={15}/><span>{wakeStatus.startupError}</span></div>}
        {['error', 'stopped', 'retrying'].includes(wakeStatus.state) && wakeStatus.enabled && <button type="button" className="wake-retry-button" onClick={retryWakeListener} disabled={wakeSettingsBusy}><RefreshCw size={14}/>{wakeSettingsBusy ? 'Starting listener…' : 'Retry wake listener'}</button>}
        {wakeStatus.state === 'listening' && <p className="wake-private-note"><CheckCircle2 size={13}/> Wake phrase audio is processed on this PC and is not saved.</p>}
        <div className="wake-diagnostics">
          <div className="wake-diagnostics-actions">
            <button type="button" className="wake-diagnostics-toggle" aria-expanded={wakeDiagnosticsOpen} onClick={() => setWakeDiagnosticsOpen(open => !open)}>
              {wakeDiagnosticsOpen ? <ChevronUp size={14}/> : <ChevronDown size={14}/>} Wake diagnostics <span>({wakeStatus.diagnostics?.length || 0})</span>
            </button>
            {!!wakeStatus.diagnostics?.length && <button type="button" className="wake-diagnostics-clear" onClick={clearWakeDiagnostics}><Trash2 size={13}/> Clear</button>}
          </div>
          {wakeDiagnosticsOpen && <div className="wake-diagnostics-log" role="log" aria-live="polite" aria-label="Local wake phrase diagnostics">
            <p>Local only: up to 50 recent events are kept in memory and cleared when Arisa exits. No microphone audio is saved.</p>
            {!wakeStatus.diagnostics?.length
              ? <div className="wake-diagnostic-empty">Waiting for a wake phrase. Say one of the three phrases while this status says “Listening locally.”</div>
              : <ol>{wakeStatus.diagnostics.map((event, index) => <li key={`${event.at}-${index}`}>
                <time>{new Date(event.at).toLocaleTimeString()}</time><span className={`wake-diagnostic-line ${event.stage === 'phrase_result' ? (event.accepted ? 'accepted' : 'rejected') : ''}`}>{wakeDiagnosticSummary(event)}</span>
              </li>)}</ol>}
          </div>}
        </div>
      </section>}

    </div>
  )
}
